const { createClient } = require("@supabase/supabase-js");

const rawSupabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

function normalizeSupabaseUrl(value) {
  if (!value) {
    return "";
  }

  try {
    const parsedUrl = new URL(value.trim());
    return parsedUrl.origin;
  } catch (error) {
    return "";
  }
}

const supabaseUrl = normalizeSupabaseUrl(rawSupabaseUrl);
const supabase = supabaseUrl && supabaseSecretKey
  ? createClient(supabaseUrl, supabaseSecretKey)
  : null;

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Method not allowed"
    });
  }

  if (!rawSupabaseUrl || !supabaseSecretKey || !supabaseUrl || !supabase) {
    return res.status(500).json({
      success: false,
      code: "SUPABASE_CONFIG_MISSING",
      message: "The readiness check system is not configured yet."
    });
  }

  try {
    const leadId = cleanText(req.body.leadId);
    const athleteGrade = cleanText(req.body.athleteGrade);
    const highSchool = cleanText(req.body.highSchool);
    const position = cleanText(req.body.position);
    const height = cleanText(req.body.height);
    const weight = cleanText(req.body.weight);
    const hudlLink = cleanText(req.body.hudlLink);
    const xAccount = cleanText(req.body.xAccount);
    const gpa = cleanText(req.body.gpa);
    const schoolsOfInterest = cleanText(req.body.schoolsOfInterest);
    const coachOutreachStatus = cleanText(req.body.coachOutreachStatus);
    const campsOrVisits = cleanText(req.body.campsOrVisits);
    const biggestConcern = cleanText(req.body.biggestConcern);
    const additionalContext = cleanText(req.body.additionalContext);

    if (!leadId || !isUuid(leadId)) {
      return res.status(400).json({
        success: false,
        code: "INVALID_LEAD_ID",
        message: "This readiness check link is not valid. Please use the link from your PlayBoard email."
      });
    }

    if (!athleteGrade || !highSchool || !position || !biggestConcern) {
      return res.status(400).json({
        success: false,
        code: "MISSING_REQUIRED_FIELDS",
        message: "Please enter grade, high school, position, and the biggest recruiting concern."
      });
    }

    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("id, parent_email, athlete_first_name, athlete_last_name")
      .eq("id", leadId)
      .single();

    if (leadError || !lead) {
      console.error("Lead lookup error:", leadError);

      return res.status(404).json({
        success: false,
        code: "LEAD_NOT_FOUND",
        message: "We could not find the original PlayBoard request. Please submit the first form again."
      });
    }

    const { data, error } = await supabase
      .from("readiness_checks")
      .insert({
        lead_id: lead.id,
        parent_email: lead.parent_email,
        athlete_first_name: lead.athlete_first_name,
        athlete_last_name: lead.athlete_last_name,
        athlete_grade: athleteGrade,
        high_school: highSchool,
        position,
        height: height || null,
        weight: weight || null,
        hudl_link: hudlLink || null,
        x_account: xAccount || null,
        gpa: gpa || null,
        schools_of_interest: schoolsOfInterest || null,
        coach_outreach_status: coachOutreachStatus || null,
        camps_or_visits: campsOrVisits || null,
        biggest_concern: biggestConcern,
        additional_context: additionalContext || null,
        user_agent: req.headers["user-agent"] || null,
        referrer: req.headers.referer || null
      })
      .select("id")
      .single();

    if (error) {
      console.error("Readiness check insert error:", error);

      return res.status(500).json({
        success: false,
        code: "READINESS_INSERT_FAILED",
        message: "Something went wrong saving the readiness check. Please try again."
      });
    }

    const { error: updateError } = await supabase
      .from("leads")
      .update({
        funnel_stage: "readiness_completed"
      })
      .eq("id", lead.id);

    if (updateError) {
      console.error("Lead funnel update error:", updateError);
    }

    return res.status(200).json({
      success: true,
      readinessCheckId: data.id,
      message: "Got it. We have the readiness check. We will review the information and follow up with the next step."
    });
  } catch (error) {
    console.error("Readiness check API error:", error);

    return res.status(500).json({
      success: false,
      code: "READINESS_API_ERROR",
      message: "Something went wrong. Please try again."
    });
  }
};
