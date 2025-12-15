import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp', 'telegram'];

// 1. GENERATOR KEYWORDS (We scan for these, but we don't delete results if missing)
const AI_LABS = [
    { name: 'Midjourney', keys: ['midjourney', 'mj_'] },
    { name: 'DALL-E', keys: ['dalle', 'dall-e'] },
    { name: 'Stable Diffusion', keys: ['stable diffusion', 'sdxl', 'stablediffusion'] },
    { name: 'Sora', keys: ['sora', 'openai'] },
    { name: 'Runway', keys: ['runway'] },
    { name: 'Pika', keys: ['pika'] },
    { name: 'Flux', keys: ['flux'] }
];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { mediaUrl } = req.body;
    const apiKey = process.env.SERPER_API_KEY;

    // DEBUG LOG OBJECT
    let debug = {
        step: "init",
        filename_detected: "none",
        lens_attempt: "pending",
        lens_raw_count: 0,
        text_fallback: "pending",
        final_verdict: "unknown"
    };

    let intel = {
        totalMatches: 0,
        isViral: false,
        ai_generator_name: "Unknown",
        matches: [],
        debug: debug // Send debug info to frontend
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const filename = mediaUrl.split('/').pop().toLowerCase();
        debug.filename_detected = filename;

        // --- PHASE 1: FILENAME SCAN ---
        for (const gen of AI_LABS) {
            if (gen.keys.some(k => filename.includes(k))) {
                intel.ai_generator_name = `${gen.name} (Filename)`;
            }
        }

        if (apiKey) {
            let allMatches = [];

            // --- PHASE 2: VISUAL SEARCH (LENS) ---
            debug.step = "lens_request";
            try {
                const lensRes = await fetch("https://google.serper.dev/lens", {
                    method: "POST",
                    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                    body: JSON.stringify({ url: mediaUrl, gl: "us", hl: "en" })
                });
                
                if (!lensRes.ok) debug.lens_attempt = `failed_${lensRes.status}`;
                else {
                    const lensData = await lensRes.json();
                    const visual = lensData.visualMatches || [];
                    debug.lens_attempt = "success";
                    debug.lens_raw_count = visual.length;
                    allMatches = visual;
                }
            } catch (e) { debug.lens_attempt = "error_" + e.message; }

            // --- PHASE 3: FALLBACK TEXT SEARCH (If Lens failed or returned 0) ---
            if (allMatches.length === 0) {
                debug.step = "text_fallback";
                // Clean filename: "my_image_123.jpg" -> "my image 123"
                const query = filename.split('.')[0].replace(/[-_]/g, ' ');
                
                if (query.length > 3) {
                    try {
                        const textRes = await fetch("https://google.serper.dev/search", {
                            method: "POST",
                            headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                            body: JSON.stringify({ q: query, gl: "us", hl: "en" })
                        });
                        const textData = await textRes.json();
                        const organic = textData.organic || [];
                        const images = textData.images || [];
                        
                        allMatches = [...organic, ...images];
                        debug.text_fallback = `found_${allMatches.length}`;
                    } catch (e) { debug.text_fallback = "error"; }
                }
            }

            // --- PHASE 4: PROCESSING (NO DELETIONS) ---
            // Filter out self-hosted links, but KEEP everything else
            const validMatches = allMatches.filter(m => 
                !IGNORED.some(d => (m.link || "").includes(d) || (m.source || "").includes(d))
            );

            intel.totalMatches = validMatches.length;
            intel.isViral = validMatches.length > 5;

            // Map results (Top 10)
            intel.matches = validMatches.slice(0, 10).map(m => {
                const title = m.title || "Untitled Match";
                const source = m.source || new URL(m.link).hostname;
                const lowerText = (title + " " + source).toLowerCase();
                
                // Tag high-value matches
                let tag = "Generic";
                if (lowerText.includes("ai") || lowerText.includes("generated")) tag = "AI-Related";
                
                return {
                    source_name: source,
                    title: `[${tag}] ${title}`,
                    url: m.link,
                    posted_time: "Found Online"
                };
            });

            // Try to find generator in the matches
            if (intel.ai_generator_name === "Unknown") {
                const combinedText = validMatches.map(m => (m.title + " " + m.snippet).toLowerCase()).join(" ");
                for (const gen of AI_LABS) {
                    if (gen.keys.some(k => combinedText.includes(k))) {
                        intel.ai_generator_name = `${gen.name} (Context Match)`;
                        break;
                    }
                }
            }
        }

        // --- PHASE 5: RETURN ---
        return res.status(200).json({
            service: "osint-diagnostic-v5",
            footprintAnalysis: intel,
            timelineIntel: { 
                first_seen: intel.matches.length > 0 ? "Found Publicly" : "Unique/Private",
                last_seen: "Just Now"
            }
        });

    } catch (e) {
        return res.status(200).json({ 
            service: "osint-crash", 
            footprintAnalysis: intel, 
            error: e.message 
        });
    }
}
