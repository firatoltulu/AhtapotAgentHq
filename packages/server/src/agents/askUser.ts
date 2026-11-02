import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * `ask_user` — agent'ın insana soru sorduğu tek kapı.
 *
 * Doğal dilde "ne yapayım?" yazmak turu bitirir ve cevabı bekleyen kimse
 * kalmaz. Bu araç promise'i BEKLETİR: SDK turu askıda kalır, UI'a
 * `agent.question` düşer, cevap gelince (ya da süre dolunca) tur sürer.
 * Süre dolunca cevap "varsayımınla devam et"tir — iş sonsuza asılı kalmaz.
 */

export interface Question {
  questionId: string;
  text: string;
  options: string[];
}

export type AskUser = (q: Question) => Promise<string>;

export const ASK_USER_SERVER = "ahtapot";
export const ASK_USER_TOOL = `mcp__${ASK_USER_SERVER}__ask_user`;

export const TIMEOUT_ANSWER = "Cevap gelmedi. Varsayımınla devam et, varsayımı raporunda belirt.";

/** Otopilot açıkken soru insana gitmez; bu cevap anında döner. */
export const AUTOPILOT_ANSWER = "Otopilot açık: insan beklenmiyor. Kararı kendin ver, gerekçesini ve varsayımını HANDOFF_JSON'da (deviations/notes) belirt ve devam et.";

export function newQuestionId(): string {
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Süreç içi MCP sunucusu; `query()` seçeneklerine `mcpServers` ile verilir. */
export function askUserServer(ask: AskUser, timeoutMs: number) {
  return createSdkMcpServer({
    name: ASK_USER_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        "ask_user",
        "İnsana soru sor ve cevabı bekle. Kararı tek başına veremediğinde kullan; tahmin etme. Seçenekler verirsen insan birini seçebilir.",
        { question: z.string().min(1), options: z.array(z.string()).optional() },
        async (args) => {
          const q: Question = { questionId: newQuestionId(), text: args.question, options: args.options ?? [] };
          const answer = await Promise.race([
            ask(q),
            new Promise<string>((r) => setTimeout(() => r(TIMEOUT_ANSWER), timeoutMs)),
          ]);
          return { content: [{ type: "text", text: answer }] };
        },
      ),
    ],
  });
}
