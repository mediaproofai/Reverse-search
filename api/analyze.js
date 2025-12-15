import fetch from 'node-fetch';

// 1. CONFIGURATION
const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp', 'telegram'];
const AI_LABS = [
    { name: 'Midjourney', keys: ['midjourney', 'mj_'] },
    { name: 'DALL-E', keys: ['dalle', 'dall-e'] },
    { name: 'Stable Diffusion', keys: ['stable-diffusion', 'sdxl'] },
    { name: 'Sora', keys: ['sora'] },
    { name: 'Runway', keys: ['runway'] },
    { name: 'Pika', keys: ['pika'] }
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
        matches: [],
        method: "None"
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        // --- PHASE 1: INSTANT FILENAME FORENSICS ---
        // Before even asking Google, look at the file name.
        // e.g., "midjourney_v5_cat.jpg" -> We know it's Midjourney immediately.
        const filename = mediaUrl.split('/').pop().toLowerCase();
        for (const gen of AI_LABS) {
            if (gen.keys.some(k => filename.includes(k))) {
                intel.ai_generator_name = `${gen.name} (Filename Trace)`;
            }
        }

        // --- PHASE 2: VISUAL SEARCH (GOOGLE LENS) ---
        if (apiKey) {
            let rawMatches = [];
            
            // Try Visual Search First
            try {
                const lensRes = await fetch("https://google.serper.dev/lens", {
                    method: "POST",
                    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                    body: JSON.stringify({ url: mediaUrl, gl: "us", hl: "en" })
                });
                const lensData = await lensRes.json();
                if (lensData.visualMatches) {
                    rawMatches = lensData.visualMatches;
                    intel.method = "Visual Fingerprint";
                }
            } catch (e) { console.log("Lens failed, trying fallback..."); }

            // --- PHASE 3: TEXT FALLBACK (If Visual Failed) ---
            // If Lens returned 0 results, search the FILENAME text on Google Images
            if (rawMatches.length === 0) {
                // Clean filename: remove extension and replace underscores/dashes with spaces
                const query = filename.split('.')[0].replace(/[-_]/g, ' ');
                
                // Only run fallback if filename is meaningful (longer than 3 chars)
                if (query.length > 3) {
                    try {
                        const textRes = await fetch("https://google.serper.dev/images", {
                            method: "POST",
                            headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                            body: JSON.stringify({ q: query, gl: "us", hl: "en" })
                        });
                        const textData = await textRes.json();
                        if (textData.images) {
                            rawMatches = textData.images;
                            intel.method = "Filename Lookup";
                        }
                    } catch (e) { console.log("Text search failed"); }
                }
            }

            // --- PHASE 4: FILTER & ANALYZE RESULTS ---
            const cleanMatches = rawMatches.filter(m => 
                !IGNORED.some(d => (m.link || "").includes(d) || (m.source || "").includes(d))
            );

            intel.totalMatches = cleanMatches.length;
            intel.isViral = cleanMatches.length > 20;

            // Map the top 8 results
            intel.matches = cleanMatches.slice(0, 8).map(m => ({
                source_name: m.source || new URL(m.link).hostname.replace('www.',''),
                title: m.title || "External Match",
                url: m.link,
                posted_time: "Online Discovery" 
            }));

            // If we still don't know the generator, scan the search result titles
            if (intel.ai_generator_name.includes("Unknown")) {
                const combinedText = cleanMatches.map(m => (m.title + " " + m.source).toLowerCase()).join(" ");
                for (const gen of AI_LABS) {
                    if (gen.keys.some(k => combinedText.includes(k))) {
                        intel.ai_generator_name = `${gen.name} (Context Match)`;
                        break;
                    }
                }
            }
        }

        // --- PHASE 5: FINAL VERDICT ---
        return res.status(200).json({
            service: "osint-dual-engine-v3",
            footprintAnalysis: intel,
            timelineIntel: { 
                first_seen: intel.matches.length > 0 ? "Found Publicly" : "Unique/Private",
                last_seen: "Just Now"
            }
        });

    } catch (e) {
        return res.status(200).json({ 
            service: "osint-critical-failure", 
            footprintAnalysis: intel, 
            error: e.message 
        });
    }
}
