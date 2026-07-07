const { getSupabaseClient } = require("./_funnel");
const { runAutomationRule } = require("./_automation-rules");

const batchLimit = clampBatchLimit(process.env.PLAYBOARD_AUTOMATION_BATCH_LIMIT || 10);

function clampBatchLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return 10;
  return Math.min(parsed, 50);
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isAuthorized(req) {
  const cronSecret = clean(process.env.CRON_SECRET);
  if (!cronSecret) return true;
  return clean(req?.headers?.authorization) === `Bearer ${cronSecret}`;
}

function getTargetLeadId(req) {
  return clean(req?.query?.leadId || req?.body?.leadId || req?.query?.testLeadId || req?.body?.testLeadId);
}

async function fetchDueQueueItems(supabase, targetLeadId = "") {
  let query = supabase
    .from("automation_queue")
    .select("id, lead_id, rule_key, payload, attempts, max_attempts, run_after, priority")
    .eq("status", "pending")
    .lte("run_after", new Date().toISOString())
    .order("priority", { ascending: true })
    .order("run_after", { ascending: true })
    .limit(batchLimit);

  if (targetLeadId) {
    query = query.eq("lead_id", targetLeadId);
  }

  const { data, error } = await query;

  if (error) throw new Error(`Automation queue query failed: ${error.message}`);
  return data || [];
}

async function claimQueueItem(supabase, queueItem) {
  const { data, error } = await supabase
    .from("automation_queue")
    .update({
      status: "processing",
      locked_at: new Date().toISOString(),
      locked_by: "automation-worker"
    })
    .eq("id", queueItem.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (error) throw new Error(`Automation claim failed: ${error.message}`);
  return Boolean(data?.id);
}

async function runWorkflow(req) {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error("Supabase is not configured for automation.");
  }

  const targetLeadId = getTargetLeadId(req);
  const dueItems = await fetchDueQueueItems(supabase, targetLeadId);
  const result = { checked: dueItems.length, processed: 0, completed: 0, skipped: 0, failed: 0, claimedByOtherWorker: 0, targetLeadId: targetLeadId || null, errors: [] };

  for (const queueItem of dueItems) {
    try {
      const claimed = await claimQueueItem(supabase, queueItem);
      if (!claimed) {
        result.claimedByOtherWorker += 1;
        continue;
      }

      result.processed += 1;
      const ruleResult = await runAutomationRule({ supabase, queueItem, req });

      if (ruleResult?.skipped) result.skipped += 1;
      else result.completed += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push({ queueItemId: queueItem.id, message: error.message });
      console.error("Automation queue item failed:", { queueItemId: queueItem.id, ruleKey: queueItem.rule_key, message: error.message });
    }
  }

  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, code: "UNAUTHORIZED" });
  }

  try {
    const result = await runWorkflow(req);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("Automation queue worker failed:", error);
    return res.status(500).json({ success: false, code: "AUTOMATION_WORKER_FAILED", message: error.message });
  }
};

module.exports.runWorkflow = runWorkflow;
module.exports.fetchDueQueueItems = fetchDueQueueItems;
module.exports.isAuthorized = isAuthorized;
