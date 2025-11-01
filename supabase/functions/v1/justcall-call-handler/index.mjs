// supabase/functions/justcall-call-handler/index.mjs
// Deno / Supabase Edge Function (ESM)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import OpenAI from "npm:openai";

import { VoicemailClassificationPrompt, PlumberClassificationPrompt } from "./prompt.mjs";

const safePreview = (txt, n = 160) => {
  if (!txt) return "";
  const s = String(txt);
  return s.length > n ? s.slice(0, n) + "…" : s;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200 });

  const receivedAt = new Date().toISOString();
  const rawBody = await req.text();

  // ---------- minimal helpers ----------
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  const normalizePhone = (value) => {
    if (!value) return null;
    const digits = String(value).replace(/[^\d+]/g, "");
    if (digits.startsWith("+")) return digits;
    if (/^\d{6,15}$/.test(digits)) return "+" + digits;
    return digits || null;
  };

  const asNumber = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  // ---------- parse payload ----------
  let payload = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // request + obs context
  const requestId = String(payload?.request_id ?? crypto.randomUUID());
  let callSid = ""; // will fill once we parse data

  const obs = (tag, extra = {}) =>
    console.log(`justcall:${tag}`, {
      requestId,
      receivedAt,
      callSid,
      ...extra,
    });

  const webhookEventType = String(payload?.type ?? payload?.event ?? "").toLowerCase();
  if (webhookEventType !== "call.completed") {
    obs("webhook:ignored", { webhookEventType });
    return json({ ok: true, ignored: true, eventType: webhookEventType }, 202);
  }

  const webhookData = payload?.data ?? payload ?? {};

  // ---------- env ----------
  const deepgramKey = Deno.env.get("DEEPGRAM_KEY");
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  // ---------- extract fields ----------
  callSid = webhookData?.call_sid ?? null;

  const partnerNumber = normalizePhone(webhookData?.justcall_number);
  const customerNumber = normalizePhone(webhookData?.contact_number ?? null);

  const callDirection = String(webhookData?.call_info?.direction || "").toLowerCase();
  let callStatus = String(webhookData?.call_info?.type || "").toLowerCase();

  // voicemail defaults false
  let voicemail = false;
  let voicemailTranscription;

  // chargeable default false
  let chargeable = false;

  // transcription for answered calls
  let transcription;

  const durationSeconds = asNumber(webhookData?.call_duration?.total_duration ?? null, 0);
  const recordingUrl = webhookData?.call_info?.recording ?? null;

  let missedBy;

  obs("webhook:received", {
    webhookEventType,
    direction: callDirection,
    status: callStatus,
    hasRecording: !!recordingUrl,
    durationSeconds,
    partnerNumber,
    customerNumber,
  });

  // ---------- business logic (unchanged) ----------
  if (callDirection === "incoming") {
    if (callStatus === "voicemail") {
      callStatus = "missed";
      voicemail = true;

      if (recordingUrl) {
        const t0 = Date.now();
        try {
          obs("transcribe:start", { urlPreview: safePreview(recordingUrl, 80) });
          const { transcript: vmText } = await callRecordingTrancriber(recordingUrl, deepgramKey);
          voicemailTranscription = vmText;
          obs("transcribe:ok", {
            ms: Date.now() - t0,
            transcriptChars: vmText?.length || 0,
            transcriptPreview: safePreview(vmText, 120),
          });

          const t1 = Date.now();
          obs("classify:start", { kind: "plumber", model: "gpt-4.1-nano", voicemailMode: false });
          chargeable = await callRecordingClassifier(vmText, PlumberClassificationPrompt, openaiKey);
          obs("classify:ok", { ms: Date.now() - t1, result: { chargeable } });
        } catch (err) {
          obs("transcribe_or_classify:error", { message: String(err?.message || err) });
        }
      }

      missedBy = "partner";
    } else if(callStatus === "missed"){
      missedBy="partner"
    } else{
      if (recordingUrl) {
        const t0 = Date.now();
        try {
          obs("transcribe:start", { urlPreview: safePreview(recordingUrl, 80) });
          const { transcript } = await callRecordingTrancriber(recordingUrl, deepgramKey);
          transcription = transcript;
          obs("transcribe:ok", {
            ms: Date.now() - t0,
            transcriptChars: transcription?.length || 0,
            transcriptPreview: safePreview(transcription, 120),
          });

            const t2 = Date.now();
            obs("classify:start", { kind: "plumber", model: "gpt-4.1-nano", voicemailMode: false });
            chargeable = await callRecordingClassifier(
              transcription,
              PlumberClassificationPrompt,
              openaiKey
            );
            obs("classify:ok", { ms: Date.now() - t2, result: { chargeable } });
          
        } catch (err) {
          obs("transcribe_or_classify:error", { message: String(err?.message || err) });
        }
      }
    }
  }

  if (callDirection === "outgoing") {
    if (callStatus !== "answered") {
      callStatus = "missed";
      missedBy = "customer";
    } else {
      if (recordingUrl) {
        const t0 = Date.now();
        try {
          obs("transcribe:start", { urlPreview: safePreview(recordingUrl, 80) });
          const { transcript } = await callRecordingTrancriber(recordingUrl, deepgramKey);
          transcription = transcript;
          obs("transcribe:ok", {
            ms: Date.now() - t0,
            transcriptChars: transcription?.length || 0,
            transcriptPreview: safePreview(transcription, 120),
          });

          const t1 = Date.now();
          obs("classify:start", { kind: "voicemail", model: "gpt-4.1-nano", voicemailMode: true });
          const customerVoicemail = await callRecordingClassifier(
            transcription,
            VoicemailClassificationPrompt,
            openaiKey,
            true
          );
          obs("classify:ok", { ms: Date.now() - t1, result: { customerVoicemail } });

          if (customerVoicemail) {
            callStatus = "missed";
            missedBy = "customer";
          } else {
            const t2 = Date.now();
            obs("classify:start", { kind: "plumber", model: "gpt-4.1-nano", voicemailMode: false });
            chargeable = await callRecordingClassifier(
              transcription,
              PlumberClassificationPrompt,
              openaiKey
            );
            obs("classify:ok", { ms: Date.now() - t2, result: { chargeable } });
          }
        } catch (err) {
          obs("transcribe_or_classify:error", { message: String(err?.message || err) });
        }
      }
    }
  }

  // ---------- validation ----------
  if (!callSid) return json({ error: "Missing call_sid" }, 400);
  if (!partnerNumber) return json({ error: "Missing justcall line number" }, 400);
  if (!customerNumber) return json({ error: "Missing customer_number" }, 400);
  if (!callDirection) return json({ error: "Missing call_direction" }, 400);

  // ---------- DB ----------
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
    global: { headers: { "X-Client-Info": "justcall-call-handler@1" } },
  });

  obs("db:partner:lookup:start", { phone: partnerNumber });
  const tDb0 = Date.now();
  const { data: partnerData, error: partnerError } = await supabase
    .from("partners")
    .select("id")
    .eq("phone", partnerNumber)
    .single();

  if (partnerError) {
    obs("db:partner:lookup:error", { ms: Date.now() - tDb0, message: String(partnerError?.message || partnerError) });
  } else {
    obs("db:partner:lookup:ok", { ms: Date.now() - tDb0, partnerId: partnerData?.id || null });
  }

  const row = {
    call_sid: callSid,
    partner_id: partnerData?.id,
    customer_number: customerNumber,
    call_direction: callDirection,
    duration: durationSeconds,
    recording_url: recordingUrl ?? null,
    transcription: transcription ?? null,
    chargeable: !!chargeable,
    call_status: callStatus,
    voicemail: !!voicemail,
    voicemail_transcription: voicemailTranscription ?? null,
    missed_by: missedBy ?? null,
  };

  obs("db:call_logs:upsert:start", {
    rowPreview: {
      call_sid: row.call_sid,
      partner_id: row.partner_id,
      customer_number: row.customer_number,
      call_direction: row.call_direction,
      duration: row.duration,
      call_status: row.call_status,
      voicemail: row.voicemail,
      missed_by: row.missed_by,
      hasRecording: !!row.recording_url,
      transcriptionChars: row.transcription?.length || 0,
      voicemailTranscriptionChars: row.voicemail_transcription?.length || 0,
    },
  });

  const tDb1 = Date.now();
  const { error: insertErr } = await supabase
    .from("call_logs")
    .upsert(row, { onConflict: "call_sid", ignoreDuplicates: false });

  if (insertErr) {
    obs("db:call_logs:upsert:error", { ms: Date.now() - tDb1, message: String(insertErr?.message || insertErr) });
    return json({ error: "DB insert failed" }, 500);
  }
  obs("db:call_logs:upsert:ok", { ms: Date.now() - tDb1 });

  // final summary
  obs("run:summary", {
    direction: callDirection,
    finalStatus: callStatus,
    missedBy,
    chargeable,
    hadTranscription: !!transcription,
    hadVoicemailTranscription: !!voicemailTranscription,
  });

  return new Response("ok", { status: 200 });
});

// --------------- utils (kept same signatures) ---------------

// Minimal: fetch the audio from a JustCall presigned URL and transcribe with Deepgram.
const callRecordingTrancriber = async (recordingUrl, deepgramKey) => {
  const tAll = Date.now();
  if (!recordingUrl || typeof recordingUrl !== "string") {
    console.log("justcall:transcribe:input:error", { reason: "recordingUrl must be non-empty string" });
    throw new Error("recordingUrl must be a non-empty string");
  }
  if (!deepgramKey) {
    console.log("justcall:transcribe:env:error", { reason: "Missing DEEPGRAM_KEY" });
    throw new Error("Missing DEEPGRAM_KEY in context.");
  }

  // 1) Download audio
  const tFetch = Date.now();
  let contentType = "application/octet-stream";
  let audioArrayBuffer;
  try {
    console.log("justcall:recording:fetch:start", { urlPreview: recordingUrl.slice(0, 80) + (recordingUrl.length > 80 ? "…" : "") });
    const audioResp = await fetch(recordingUrl, { redirect: "follow" });
    if (!audioResp.ok) {
      const errTxt = await audioResp.text().catch(() => "");
      console.log("justcall:recording:fetch:error", { status: audioResp.status, textPreview: safePreview(errTxt, 140) });
      throw new Error(`Fetch recording failed: ${audioResp.status} ${errTxt}`);
    }
    const headerType = audioResp.headers.get("content-type")?.split(";")[0] || "";
    contentType = headerType || contentType;
    audioArrayBuffer = await audioResp.arrayBuffer();
    console.log("justcall:recording:fetch:ok", {
      ms: Date.now() - tFetch,
      contentType,
      bytes: audioArrayBuffer?.byteLength || 0,
    });
  } catch (err) {
    console.log("justcall:recording:fetch:exception", { message: String(err?.message || err) });
    throw err;
  }

  // Guess by extension (fallback)
  const ext = (() => {
    try {
      const pathname = new URL(recordingUrl).pathname || "";
      return pathname.split(".").pop()?.toLowerCase() || "";
    } catch {
      return "";
    }
  })();
  if (!contentType || contentType === "application/octet-stream") {
    contentType =
      ext === "mp3" ? "audio/mpeg" :
      ext === "wav" ? "audio/wav" :
      ext === "m4a" ? "audio/mp4" :
      "application/octet-stream";
  }

  // 2) Deepgram transcription
  const tDg = Date.now();
  const dgUrl = "https://api.deepgram.com/v1/listen?model=nova-3&multichannel=true&smart_format=true&utterances=true";
  let dgJson;
  try {
    console.log("justcall:deepgram:start", { contentType, bytes: audioArrayBuffer?.byteLength || 0 });
    const dgResp = await fetch(dgUrl, {
      method: "POST",
      headers: {
        Authorization: `Token ${deepgramKey}`,
        "Content-Type": contentType,
      },
      body: audioArrayBuffer,
    });

    if (!dgResp.ok) {
      const errTxt = await dgResp.text().catch(() => "");
      console.log("justcall:deepgram:error", { status: dgResp.status, textPreview: safePreview(errTxt, 180) });
      throw new Error(`Deepgram failed: ${dgResp.status} ${errTxt}`);
    }

    dgJson = await dgResp.json();
  } catch (err) {
    console.log("justcall:deepgram:exception", { message: String(err?.message || err) });
    throw err;
  }

  if (!dgJson?.results?.channels) {
    console.log("justcall:deepgram:format:error", { note: "No results.channels" });
    throw new Error("Invalid Deepgram response format");
  }

  const role = (ch) => (ch === 0 ? "Customer" : "Agent");
  const turns = (dgJson.results.utterances || [])
    .map((u) => `${role(u.channel)}: ${u.transcript}`)
    .join("\n");

  const transcript =
    turns ||
    (dgJson.results.channels || [])
      .map((ch, i) => `Speaker ${i + 1}: ${ch.alternatives?.[0]?.transcript || ""}`)
      .join("\n")
      .trim();

  console.log("justcall:deepgram:ok", {
    ms: Date.now() - tDg,
    transcriptChars: transcript?.length || 0,
    totalMs: Date.now() - tAll,
  });

  return { transcript, deepgram: dgJson };
};

const callRecordingClassifier = async (transcription, classificationPrompt, apiKey, voicemailClassification = false) => {
  const tAll = Date.now();
  const openai = new OpenAI({ apiKey });

  try {
    if (!voicemailClassification) {
      console.log("justcall:openai:classify:start", {
        model: "gpt-4.1-nano",
        kind: "plumber",
        inputChars: transcription?.length || 0,
        promptPreview: safePreview(classificationPrompt, 120),
      });

      const resp = await openai.responses.create({
        model: "gpt-4.1-nano",
        temperature: 0,
        max_output_tokens: 16,
        text: {
          format: {
            type: "json_schema",
            name: "intent_schema",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: { intent: { type: "string", enum: ["genuine", "not_genuine"] } },
              required: ["intent"],
            },
            strict: true,
          },
        },
        input: [
          { role: "system", content: [{ type: "input_text", text: classificationPrompt }] },
          { role: "user", content: [{ type: "input_text", text: transcription }] },
        ],
      });

      const { output_text } = resp;
      let intent = "";
      try {
        intent = JSON.parse(output_text)?.intent || "";
      } catch {
        console.log("justcall:openai:classify:parse:error", { outputPreview: safePreview(String(output_text || ""), 140) });
        intent = "";
      }
      const result = intent === "genuine";
      console.log("justcall:openai:classify:ok", { ms: Date.now() - tAll, result });
      return result;
    } else {
      console.log("justcall:openai:classify:start", {
        model: "gpt-4.1-nano",
        kind: "voicemail",
        inputChars: transcription?.length || 0,
        promptPreview: safePreview(classificationPrompt, 120),
      });

      const resp = await openai.responses.create({
        model: "gpt-4.1-nano",
        temperature: 0,
        max_output_tokens: 16,
        text: {
          format: {
            type: "json_schema",
            name: "intent_schema",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: { voicemail: { type: "string", enum: ["true", "false"] } },
              required: ["voicemail"],
            },
            strict: true,
          },
        },
        input: [
          { role: "system", content: [{ type: "input_text", text: classificationPrompt }] },
          { role: "user", content: [{ type: "input_text", text: transcription }] },
        ],
      });

      let voicemailStr = "";
      try {
        voicemailStr = String(JSON.parse(resp.output_text)?.voicemail || "").toLowerCase();
      } catch (_) {
        console.log("justcall:openai:classify:parse:error", {
          outputPreview: safePreview(String(resp.output_text || ""), 140),
        });
        voicemailStr = "";
      }
      const result = voicemailStr === "true";
      console.log("justcall:openai:classify:ok", { ms: Date.now() - tAll, result });
      return result;
    }
  } catch (err) {
    console.log("justcall:openai:classify:exception", { message: String(err?.message || err) });
    throw err;
  }
};
