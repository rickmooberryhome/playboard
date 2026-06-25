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

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Method not allowed"
    });
  }

  if (!rawSupabaseUrl || !supabaseSecretKey) {
    console.error("Missing Supabase environment variables.");

    return res.status(500).json({
      success: false,
      code: "SUPABASE_CONFIG_MISSING",
      message: "The lead system is not configured yet. Check SUPABASE_URL and SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY in Vercel."
    });
  }

  if (!supabaseUrl || !supabase) {
    console.error("Invalid Supabase URL.");

    return res.status(500).json({
      success: false,
      code: "SUPABASE_URL_INVALID",
      message: "The Supabase project URL is invalid. Use the project URL format: https://YOUR-PROJECT-REF.supabase.co"
    });
  }

  try {
    const athleteFirstName = cleanText(req.body.firstName);
    const athleteLastName = cleanText(req.body.lastName);
    const parentEmail = cleanText(req.body.email || req.body.Email);
    const biggestQuestion = cleanText(req.body.biggestQuestion);

    if (!athleteFirstName || !athleteLastName || !parentEmail) {
      return res.status(400).json({
        success: false,
        code: "MISSING_REQUIRED_FIELDS",
        message: "Please enter the athlete's first name, last name, and email."
      });
    }

    if (!isValidEmail(parentEmail)) {
      return res.status(400).json({
        success: false,
        code: "INVALID_EMAIL",
        message: "Please enter a valid email address."
      });
    }

    const { data, error } = await supabase
      .from("leads")
      .insert({
        athlete_first_name: athleteFirstName,
        athlete_last_name: athleteLastName,
        parent_email: parentEmail.toLowerCase(),
        biggest_question: biggestQuestion || null,
        source: "landing_page",
        funnel_stage: "simple_lead",
        user_agent: req.headers["user-agent"] || null,
        referrer: req.headers.referer || null
      })
      .select("id")
      .single();

    if (error) {
      console.error("Supabase insert error:", error);

      return res.status(500).json({
        success: false,
        code: "SUPABASE_INSERT_FAILED",
        supabaseCode: error.code || null,
        message: error.code === "PGRST125"
          ? "The Supabase URL appears to include an invalid path. In Vercel, SUPABASE_URL should be the project URL only: https://YOUR-PROJECT-REF.supabase.co"
          : "Something went wrong saving your request. Please check the Supabase leads table columns."
      });
    }

    return res.status(200).json({
      success: true,
      leadId: data.id,
      message: "Thanks — we have your information request. Check your email for the next step."
    });
  } catch (error) {
    console.error("Lead API error:", error);

    return res.status(500).json({
      success: false,
      code: "LEAD_API_ERROR",
      message: "Something went wrong. Please try again."
    });
  }
};
