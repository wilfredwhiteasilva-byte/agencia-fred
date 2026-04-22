import type { Context, Config } from "@netlify/functions";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Executive Board - F.R.I.D.A.Y.
 * Handler que recebe uma pergunta estratégica, consulta o Claude,
 * grava histórico no N8N via context.waitUntil (garantido) e devolve a análise.
 */

type Mode = "full" | "brief";

interface BoardRequest {
  question: string;
  mode?: Mode;
  user_id?: string;
}

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

// ---------- Helpers ----------

async function parseBody(req: Request): Promise<BoardRequest | null> {
  try {
    const parsed = await req.json();
    if (typeof parsed?.question !== "string" || !parsed.question.trim()) {
      return null;
    }
    return {
      question: parsed.question.trim(),
      mode: parsed.mode === "brief" ? "brief" : "full",
      user_id: typeof parsed.user_id === "string" ? parsed.user_id : undefined,
    };
  } catch {
    return null;
  }
}

async function logToN8N(payload: {
  question: string;
  response: string;
  model: string;
  mode: Mode;
  user_id?: string;
  latency_ms: number;
  timestamp: string;
}): Promise<void> {
  const url = process.env.N8N_MEMORIA_WEBHOOK;
  if (!url) {
    console.warn("[waitUntil][n8n] N8N_MEMORIA_WEBHOOK não configurada — pulando log");
    return;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "<no body>");
      console.warn(`[waitUntil][n8n] Webhook retornou ${res.status}: ${txt}`);
      return;
    }

    console.log("[waitUntil][n8n] Histórico gravado com sucesso");
  } catch (err) {
    console.error(
      "[waitUntil][n8n] Falha ao gravar histórico:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------- Handler ----------

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
      { ok: false, error: "Método não permitido. Use POST.", code: "METHOD_NOT_ALLOWED" },
      { status: 405 },
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[config] ANTHROPIC_API_KEY ausente");
    return Response.json(
      { ok: false, error: "Configuração do servidor incompleta.", code: "MISSING_API_KEY" },
      { status: 500 },
    );
  }

  const parsed = await parseBody(req);
  if (!parsed) {
    return Response.json(
      {
        ok: false,
        error: "Body inválido. Esperado: { question: string, mode?: 'full'|'brief' }",
        code: "BAD_REQUEST",
      },
      { status: 400 },
    );
  }

  const { question, mode = "full", user_id } = parsed;

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
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!responseText) {
      throw new Error("Claude retornou resposta vazia");
    }

    context.waitUntil(
      logToN8N({
        question,
        response: responseText,
        model: MODEL,
        mode,
        user_id,
        latency_ms,
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
      {
        ok: false,
        error: "Falha ao consultar o modelo. Tente novamente em alguns segundos.",
        code: "CLAUDE_ERROR",
        detail: msg,
      },
      { status: 502 },
    );
  }
};

export const config: Config = {
  path: "/.netlify/functions/executive-board-handler",
};
