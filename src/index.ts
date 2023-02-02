import {
    OpenAIApi,
    Configuration,
    CreateCompletionRequest,
    CreateCompletionResponseUsage,
} from "openai";
import Tg from "node-telegram-bot-api";

import { sleep } from "@/utils";

const OPENAI_TOKEN = "";
const BOT_TOKEN = "";
const ROOMS_IDS: number[] = [];
const OPS_IDS: number[] = [];

(async () => {
    console.log("logging in openai...");
    const openaiApi = new OpenAIApi(new Configuration({ apiKey: OPENAI_TOKEN }));

    console.log("logging in telegram...");
    const tg = new Tg(BOT_TOKEN, { polling: true });
    const botInfo = await tg.getMe();

    console.log("done!");

    type ChatlogEntry = {
        firstName: string;
        username?: string;
        userId: number;
        msg: string;
        msgId: number;
        repliesTo?: number;
    };

    const chatlogs: Map<number, ChatlogEntry[]> = new Map();

    function msgToLogEntry(msg: Tg.Message): ChatlogEntry {
        const { from } = msg;
        if (!from) {
            throw new Error("no from");
        }

        return {
            firstName: from.first_name,
            username: from.username,
            userId: from.id,
            msg: msg.text ?? "",
            msgId: msg.message_id,
            repliesTo: msg.reply_to_message?.message_id,
        };
    }

    function logEntryToStr(entry: ChatlogEntry) {
        const repliesTo = entry.repliesTo ? `,${entry.repliesTo}` : "";
        return `${entry.firstName}: ${entry.msgId}${repliesTo}: ${entry.msg}~~~`;
    }

    function getPrompt(
        chatlog: ChatlogEntry[],
        includeReply?: ChatlogEntry,
    ): CreateCompletionRequest {
        const shouldIncludeReply =
            includeReply &&
            chatlog.find((entry) => entry.msgId === includeReply.msgId) !== undefined;

        const lastMsgId = chatlog[chatlog.length - 1].msgId;

        //         const prompt = `You will be introduced to a Telegram group chat. Your username is "soirtichautbot". You will only answer to the last message sent. You must never break out of your role. Here is the chatlog:
        //
        // ${shouldIncludeReply ? logEntryToStr(includeReply) : ""}
        // ${chatlog
        //     .slice(chatlog.length - 10, chatlog.length)
        //     .map(logEntryToStr)
        //     .join("\n")}`;

        const prompt = `You will be introduced to a chatlog from a Telegram groupchat called "the soirgang". The last entry of the chatlog is incomplete, you have to complete by strictly respecting the described format. Do not write anything else.

The user "soirtichautbot":
- never pretends to know something he doesn't
- knows only about is what is included in the chatlog and also about generally well-known facts
- sometimes write using slangs
- is very smart, knows about technology, science and history

Each entries of the chatlog:
- repect one of these formats:
  1. For simple message: "<INSERT_USERNAME>: <INSERT_MESSAGE_ID>: <INSERT_MESSAGE>"
  2. For a reply: "<INSERT_USERNAME>: <INSERT_MESSAGE_ID>,<INSERT_REPLY_TARGET_ID>: <INSERT_MESSAGE_CONTENT>"
- can span accross multiple lines
- are terminated by "~~~"

The message ids are always incremented by one.

Here's the chatlog:
${shouldIncludeReply ? logEntryToStr(includeReply) : ""}
${chatlog
    .slice(chatlog.length - 10, chatlog.length)
    .map(logEntryToStr)
    .join("\n")}
soirtichautbot: ${lastMsgId + 1},${lastMsgId}:`;

        console.log(`"""\n`, prompt, `"""\n`);

        return {
            model: "text-davinci-003",
            // model: "text-ada-001",
            prompt,
            max_tokens: 1000,
            suffix: "~~~",
            user: chatlog[chatlog.length - 1].userId.toString(),
        };
    }

    const msgQueue: Array<Tg.Message> = [];

    tg.on("message", (msg) => {
        msgQueue.push(msg);
    });

    function getTotalUsage(usage: CreateCompletionResponseUsage): number {
        return Object.values(usage).reduce((sum, value: string) => sum + value, 0);
    }

    async function handleMsg(msg: Tg.Message) {
        const roomId = msg.chat.id;
        const chatlog = chatlogs.get(roomId) || [];

        const isOp = msg.from?.id && OPS_IDS.includes(msg.from.id);

        const isAuthorized = isOp || ROOMS_IDS.includes(roomId);

        if (isAuthorized) {
            chatlog.push(msgToLogEntry(msg));
        }

        const shouldAnswer =
            OPS_IDS.includes(roomId) ||
            (isAuthorized &&
                (msg.reply_to_message?.from?.id === botInfo.id ||
                    (botInfo.username && msg.text?.includes(botInfo.username))));

        const isComplete = isOp && msg.text?.startsWith("???");

        console.log(
            "received:",
            msg.message_id,
            `${msg.from?.first_name}(${msg.from?.id}): `,
            msg.text,
        );

        if (shouldAnswer && msg.from?.id && msg.text) {
            let includeHistory: ChatlogEntry | undefined;

            if (msg.reply_to_message?.text && msg.reply_to_message?.from) {
                includeHistory = msgToLogEntry(msg.reply_to_message);
            }

            console.log("generating response...");

            try {
                await tg.sendChatAction(roomId, "typing");

                let apiResponse;

                if (isComplete) {
                    const splitted = msg.text?.split("#####", 2)[1];
                    apiResponse = await openaiApi.createEdit({
                        model: "text-davinci-edit-001",
                        instruction: splitted[0].slice(3),
                        input: splitted[1],
                    });
                } else {
                    apiResponse = await openaiApi.createCompletion(
                        getPrompt(chatlog, includeHistory),
                    );
                }

                console.log("[DEBUG]", JSON.stringify(apiResponse.data.choices, null, 2));

                if (!apiResponse.data.choices[0].text || !apiResponse.data.usage) {
                    throw new Error("empty response");
                }

                const response = apiResponse.data.choices[0].text.trim();

                chatlog.push({
                    firstName: botInfo.first_name || "soirtichautbot",
                    username: botInfo.username,
                    userId: botInfo.id,
                    msg: response,
                    msgId: chatlog[chatlog.length - 1].msgId + 1,
                    repliesTo: msg.message_id,
                });

                console.log(
                    `sending (${getTotalUsage(apiResponse.data.usage)}):`,
                    response.slice(0, 30),
                );

                await tg.sendMessage(roomId, response, {
                    reply_to_message_id: msg.message_id,
                });
            } catch (e) {
                console.log("something went wrong", (e as unknown as any).message);
            }

            chatlogs.set(roomId, chatlog);
        }
    }

    while (true) {
        const msg = msgQueue.shift();
        if (msg) {
            await handleMsg(msg);
        }
        await sleep(1000);
    }
})();
