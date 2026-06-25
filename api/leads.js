import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

const supabase = supabaseUrl && supabaseSecretKey
  ? createClient(supabaseUrl, supabaseSecretKey)
  : null;

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  if (!supabase) {
    console.error("Missing Supabase environment variables.");

    return res.status(500).json({
      success: false,
      message: "The lead system is not configured yet."
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
        message: "Please enter the athlete's first name, last name, and email."
      });
    }

    if (!isValidEmail(parentEmail)) {
      return res.status(400).json({
        success: false,
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
        message: "Something went wrong saving your request. Please try again."
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
      message: "Something went wrong. Please try again."
    });
  }
}
