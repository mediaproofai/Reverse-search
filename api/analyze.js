import fetch from 'node-fetch';

// 1. TRUSTED AI HUBS (High Confidence Sources)
const AI_DOMAINS = ['civitai.com', 'lexica.art', 'midjourney.com', 'discord.com', 'reddit.com', 'twitter.com', 'x.com', 'runwayml.com', 'pikalabs.org'];

// 2. GENERATOR FINGERPRINTS (Filename Regex)
// Midjourney often looks like: 'grid_0_uuid' or 'user_prompt_uuid'
// Stable Diffusion often looks like: 'date-time-seed'
const FILENAME_PATTERNS = [
    { name: 'Midjourney', regex: /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}/i }, // UUID pattern
    { name: 'Stable Diffusion', regex: /-\d{5,10}-/ }, // Seed numbers
    { name: 'DALL-E', regex: /DALL·E/i },
    { name: 'Runway', regex: /Runway/i }
];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { mediaUrl } = req.body;
    const apiKey = process.env.SERPER_API_KEY;

    let intel = {
        totalMatches: 0,
        isViral: false,
        ai_generator_name: "Unknown",
        matches: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const filename = mediaUrl.split('/').pop();

        // --- PHASE 1: FILENAME REGEX SCAN ---
        // Check if the filename itself reveals the generator
        for (const gen of FILENAME_PATTERNS) {
            if (gen.regex.test(filename) || filename.toLowerCase().includes(gen.name.toLowerCase())) {
                intel.ai_generator_name = `${gen.name} (Detected via Filename)`;
            }
        }

        // --- PHASE 2: VISUAL SEARCH (Strict Mode) ---
        if (apiKey) {
            const lensRes = await fetch("https://google.serper.dev/lens", {
                method: "POST",
                headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                body: JSON.stringify({ url: mediaUrl, gl: "us", hl: "en" })
            });
            
            const data = await lensRes.json();
            const rawMatches = data.visualMatches || [];

            // *** THE FIX: RELEVANCE SCORING ***
            const scoredMatches = rawMatches.map(m => {
                let score = 0;
                const text = (m.title + " " + m.source).toLowerCase();

                // Point 1: Does it mention AI?
                if (text.includes("ai ") || text.includes("generated") || text.includes("prompt") || text.includes("diffusion")) score += 2;
                
                // Point 2: Is it from a known AI art site?
                if (AI_DOMAINS.some(d => m.link.includes(d))) score += 3;

                // Point 3: Is it an EXACT visual match? (Serper sometimes flags this)
                if (m.position && m.position === 1) score += 1;

                return { ...m, score };
            });

            // FILTER: Only keep matches with a score > 0 OR top 3 results if they look decent
            // This removes random "visually similar" wallpapers that have no AI context.
            const validMatches = scoredMatches
                .filter(m => m.score > 0)
                .sort((a, b) => b.score - a.score);

            intel.totalMatches = validMatches.length;
            intel.isViral = validMatches.length > 10;

            intel.matches = validMatches.slice(0, 5).map(m => ({
                source_name: m.source,
                title: m.title,
                url: m.link,
                posted_time: "Found via Visual Match"
            }));

            // --- PHASE 3: CONTEXTUAL GENERATOR DETECTION ---
            // If we found valid matches, scan them for generator names
            if (intel.ai_generator_name.includes("Unknown") && validMatches.length > 0) {
                const combinedText = validMatches.map(m => m.title).join(" ").toLowerCase();
                
                if (combinedText.includes("midjourney")) intel.ai_generator_name = "Midjourney";
                else if (combinedText.includes("stable diffusion") || combinedText.includes("civitai")) intel.ai_generator_name = "Stable Diffusion";
                else if (combinedText.includes("dall-e") || combinedText.includes("bing image")) intel.ai_generator_name = "DALL-E";
                else if (combinedText.includes("sora")) intel.ai_generator_name = "Sora";
                else if (combinedText.includes("pika")) intel.ai_generator_name = "Pika Labs";
                else if (combinedText.includes("runway")) intel.ai_generator_name = "Runway Gen-2";
            }
        }

        return res.status(200).json({
            service: "osint-strict-v4",
            footprintAnalysis: intel,
            timelineIntel: { 
                first_seen: intel.matches.length > 0 ? "Publicly Indexed" : "Private / New Upload",
                last_seen: "Just Now"
            }
        });

    } catch (e) {
        return res.status(200).json({ service: "osint-fail", footprintAnalysis: intel, error: e.message });
    }
}
