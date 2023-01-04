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
const ROOM_ID = 0;
const OPS_IDS = [0];

(async () => {
    console.log("logging in openai...");
    const openaiApi = new OpenAIApi(new Configuration({ apiKey: OPENAI_TOKEN }));

    console.log("logging in telegram...");
    const tg = new Tg(BOT_TOKEN, { polling: true });
    const botInfo = await tg.getMe();

    console.log("done!");

    type ChatlogEntry = { username: string; msg: string; msgId: number; repliesTo?: number };

    const chatlogs: Map<number, ChatlogEntry[]> = new Map();

    function logEntryToStr(entry: ChatlogEntry) {
        const repliesTo = entry.repliesTo ? `,${entry.repliesTo}` : "";
        return `${entry.username}: ${entry.msgId}${repliesTo}: ${entry.msg}~~~`;
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

        const isOp = msg.from?.id && OPS_IDS.includes(msg.from.id);

        const isAuthorized = isOp || roomId === ROOM_ID;

        const shouldAnswer =
            OPS_IDS.includes(roomId) ||
            (isAuthorized &&
                (msg.reply_to_message?.from?.id === botInfo.id ||
                    (botInfo.username && msg.text?.includes(botInfo.username))));

        console.log(
            "received:",
            msg.message_id,
            `${msg.from?.first_name}(${msg.from?.id}): `,
            msg.text,
        );

        if (shouldAnswer && msg.from?.id && msg.text) {
            const chatlog = chatlogs.get(roomId) || [];

            chatlog.push({
                username: msg.from.first_name,
                msgId: msg.message_id,
                msg: msg.text,
                repliesTo: msg.reply_to_message?.message_id,
            });

            let includeHistory: ChatlogEntry | undefined;

            if (msg.reply_to_message?.text && msg.reply_to_message?.from) {
                includeHistory = {
                    username: msg.reply_to_message.from.first_name,
                    msg: msg.reply_to_message.text,
                    msgId: msg.reply_to_message.message_id,
                };
            }

            console.log("generating response...");

            try {
                await tg.sendChatAction(roomId, "typing");

                const apiResponse = await openaiApi.createCompletion(
                    getPrompt(chatlog, includeHistory),
                );

                console.log("[DEBUG]", JSON.stringify(apiResponse.data.choices, null, 2));

                if (!apiResponse.data.choices[0].text || !apiResponse.data.usage) {
                    throw new Error("empty response");
                }

                const response = apiResponse.data.choices[0].text.trim();

                chatlog.push({
                    username: botInfo.username || "soirtichautbot",
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
