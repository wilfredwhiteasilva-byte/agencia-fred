import type { Handler, HandlerEvent } from "@netlify/functions";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Executive Board - F.R.I.D.A.Y.
 * Handler que recebe uma pergunta estratégica, consulta o Claude,
 * grava histórico no N8N (fire-and-forget) e devolve a análise.
 *
 * Contrato:
 *  POST /.netlify/functions/executive-board-handler
 *  Body: { "question": string, "mode"?: "full" | "brief", "user_id"?: string }
 *  Resposta 200: { ok: true, response: string, model: string, mode: string, latency_ms: number }
 *  Resposta 4xx/5xx: { ok: false, error: string, code: string }
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

function jsonResponse(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}

function parseBody(raw: string | null): BoardRequest | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
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

/**
 * Envia o histórico pro N8N sem bloquear a resposta (fire-and-forget).
 * Se o webhook falhar, logamos mas não derrubamos o request principal.
 */
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
    console.warn("[N8N] N8N_MEMORIA_WEBHOOK não configurada — pulando log");
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[N8N] Webhook retornou ${res.status}: ${await res.text()}`);
    } else {
      console.log("[N8N] Histórico gravado com sucesso");
    }
  } catch (err) {
    console.warn("[N8N] Falha ao gravar histórico:", err instanceof Error ? err.message : err);
  }
}

// ---------- Handler ----------

export const handler: Handler = async (event: HandlerEvent) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return jsonResponse(204, {});
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, {
      ok: false,
      error: "Método não permitido. Use POST.",
      code: "METHOD_NOT_ALLOWED",
    });
  }

  // Validar env vars críticas
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[CONFIG] ANTHROPIC_API_KEY ausente");
    return jsonResponse(500, {
      ok: false,
      error: "Configuração do servidor incompleta.",
      code: "MISSING_API_KEY",
    });
  }

  // Parse & validar body
  const parsed = parseBody(event.body);
  if (!parsed) {
    return jsonResponse(400, {
      ok: false,
      error: "Body inválido. Esperado: { question: string, mode?: 'full'|'brief' }",
      code: "BAD_REQUEST",
    });
  }

  const { question, mode = "full", user_id } = parsed;

  // Chamar Claude
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

    // Extrair texto (resposta pode ter múltiplos blocos)
    const responseText = completion.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!responseText) {
      throw new Error("Claude retornou resposta vazia");
    }

    // Fire-and-forget: não awaita o N8N pra não atrasar a resposta ao caller
    void logToN8N({
      question,
      response: responseText,
      model: MODEL,
      mode,
      user_id,
      latency_ms,
      timestamp: new Date().toISOString(),
    });

    return jsonResponse(200, {
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
    console.error("[CLAUDE] Erro:", msg);
    return jsonResponse(502, {
      ok: false,
      error: "Falha ao consultar o modelo. Tente novamente em alguns segundos.",
      code: "CLAUDE_ERROR",
      detail: msg,
    });
  }
};
