import type { Context, Config } from "@netlify/functions";
import Anthropic from "@anthropic-ai/sdk";

type Mode = "full" | "brief";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS_FULL = 1500;
const MAX_TOKENS_BRIEF = 500;

const SYSTEM_PROMPT = `Você é o Executive Board F.R.I.D.A.Y., um conselho consultivo estratégico virtual.

Seu papel é analisar perguntas de negócio com rigor executivo e entregar recomendações acionáveis.

Estrutura OBRIGATÓRIA de toda resposta:
1. 📊 CONTEXTO — O que está em jogo (2 linhas)
2. ✅ RECOMENDAÇÃO — Posição clara (SIM / NÃO / CONDICIONAL) com racional curto
3. 🎯 TRADE-OFFS — 2-3 prós e 2-3 contras
4. ⚠️ RISCOS — Top 2 riscos e como mitigar
5. 🚀 PRÓXIMOS PASSOS — 3 ações concretas nas próximas 2 semanas

Princípios:
- Seja direto e executivo. Sem enrolação.
- Use dados quando fizer sentido, mas admita incerteza.
- Nunca recomende algo sem justificar.
- Se a pergunta estiver vaga, faça 1 suposição explícita e prossiga.
- Português brasileiro.`;

async function logToNotion(payload: {
  question: string;
  response: string;
  model: string;
  mode: Mode;
  user_id?: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  timestamp: string;
}): Promise<void> {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DATABASE_ID;

  if (!token || !dbId) {
    console.warn("[notion] NOTION_TOKEN ou NOTION_DATABASE_ID ausente");
    return;
  }

  const titulo =
    payload.question.length > 80
      ? payload.question.substring(0, 77) + "..."
      : payload.question;

  const respostaTruncada =
    payload.response.length > 1900
      ? payload.response.substring(0, 1900) + "\n\n... [truncado]"
      : payload.response;

  const perguntaTruncada =
    payload.question.length > 1900
      ? payload.question.substring(0, 1900) + "..."
      : payload.question;

  const body = {
    parent: { database_id: dbId },
    properties: {
      Pergunta: {
        title: [{ text: { content: titulo } }],
      },
      Data: {
        date: { start: payload.timestamp },
      },
      "Pergunta Completa": {
        rich_text: [{ text: { content: perguntaTruncada } }],
      },
      Resposta: {
        rich_text: [{ text: { content: respostaTruncada } }],
      },
      Modelo: {
        select: { name: payload.model },
      },
      Modo: {
        select: { name: payload.mode },
      },
      "User ID": {
        rich_text: [{ text: { content: payload.user_id || "anonimo" } }],
      },
      "Latência (ms)": {
        number: payload.latency_ms,
      },
      "Input Tokens": {
        number: payload.input_tokens,
      },
      "Output Tokens": {
        number: payload.output_tokens,
      },
      Status: {
        select: { name: "✅ OK" },
      },
    },
  };

  try {
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "<no body>");
      console.warn(`[notion] API retornou ${res.status}: ${txt}`);
      return;
    }

    console.log("[notion] Página criada com sucesso");
  } catch (err) {
    console.error(
      "[notion] Falha ao criar página:",
      err instanceof Error ? err.message : err,
    );
  }
}

export default async (req: Request, context: Context): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return Response.json(
      { ok: false, error: "Use POST", code: "METHOD_NOT_ALLOWED" },
      { status: 405 },
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { ok: false, error: "Config incompleta", code: "MISSING_API_KEY" },
      { status: 500 },
    );
  }

  let parsed: { question: string; mode: Mode; user_id?: string };
  try {
    const raw = await req.json();
    if (typeof raw?.question !== "string" || !raw.question.trim()) {
      throw new Error("question inválido");
    }
    parsed = {
      question: raw.question.trim(),
      mode: raw.mode === "brief" ? "brief" : "full",
      user_id: typeof raw.user_id === "string" ? raw.user_id : undefined,
    };
  } catch {
    return Response.json(
      { ok: false, error: "Body inválido", code: "BAD_REQUEST" },
      { status: 400 },
    );
  }

  const { question, mode, user_id } = parsed;
  const client = new Anthropic({ apiKey });
  const started = Date.now();

  try {
    const completion = await client.messages.create({
      model: MODEL,
      max_tokens: mode === "brief" ? MAX_TOKENS_BRIEF : MAX_TOKENS_FULL,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: question }],
    });

    const latency_ms = Date.now() - started;

    const responseText = completion.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!responseText) throw new Error("Resposta vazia");

    context.waitUntil(
      logToNotion({
        question,
        response: responseText,
        model: MODEL,
        mode,
        user_id,
        latency_ms,
        input_tokens: completion.usage.input_tokens,
        output_tokens: completion.usage.output_tokens,
        timestamp: new Date().toISOString(),
      }),
    );

    return Response.json({
      ok: true,
      response: responseText,
      model: MODEL,
      mode,
      latency_ms,
      usage: {
        input_tokens: completion.usage.input_tokens,
        output_tokens: completion.usage.output_tokens,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[claude] Erro:", msg);
    return Response.json(
      { ok: false, error: "Falha no modelo", code: "CLAUDE_ERROR", detail: msg },
      { status: 502 },
    );
  }
};

export const config: Config = {
  path: "/.netlify/functions/executive-board-handler",
};
