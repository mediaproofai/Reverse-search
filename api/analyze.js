import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { mediaUrl, type } = req.body;
    
    // NEW KEY: Check for SEARCHAPI_API_KEY
    const apiKey = process.env.SEARCHAPI_API_KEY; 

    let intel = {
        totalMatches: 0,
        ai_generator_name: "Unknown",
        matches: [],
        method: "None",
        version: "osint-provider-switch-v39",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        // --- STEP 1: EXECUTE SEARCHAPI.IO ---
        // This provider spins up a real browser, bypassing the "API Block"
        if (apiKey) {
            try {
                const params = new URLSearchParams({
                    engine: "google_lens",
                    url: mediaUrl,
                    api_key: apiKey,
                });

                intel.debug.push(`Calling SearchApi.io (Real Browser Engine)`);
                
                const searchRes = await fetch(`https://www.searchapi.io/api/v1/search?${params}`);
                const data = await searchRes.json();

                if (data.error) {
                    intel.debug.push(`Provider Error: ${JSON.stringify(data.error)}`);
                } else {
                    let rawMatches = [];

                    // 1. Knowledge Graph
                    if (data.knowledge_graph) {
                        rawMatches.push({
                            title: data.knowledge_graph.title,
                            link: data.knowledge_graph.link || "#",
                            source: "Knowledge Graph"
                        });
                    }

                    // 2. Visual Matches
                    if (data.visual_matches) {
                        rawMatches = rawMatches.concat(data.visual_matches);
                    }

                    // 3. Organic Results (Fallback)
                    if (data.organic_results) {
                        rawMatches = rawMatches.concat(data.organic_results);
                    }

                    if (rawMatches.length > 0) intel.method = "SearchApi Browser Render";
                    
                    // --- PROCESSING ---
                    const cleanMatches = rawMatches.filter(m => 
                        !IGNORED.some(d => (m.link || "").includes(d))
                    );

                    intel.totalMatches = cleanMatches.length;

                    intel.matches = cleanMatches.slice(0, 10).map(m => ({
                        source_name: m.source || m.title || "Web Result",
                        title: m.title || "External Match",
                        url: m.link || "#",
                        posted_time: "Found Online"
                    }));

                    // Context Gen ID
                    const combined = cleanMatches.map(m => (m.title||"") + " " + (m.source||"")).join(" ").toLowerCase();
                    if (combined.includes("midjourney")) intel.ai_generator_name = "Midjourney (Context)";
                    else if (combined.includes("stable diffusion")) intel.ai_generator_name = "Stable Diffusion (Context)";
                }

            } catch (e) { intel.debug.push(`Network Error: ${e.message}`); }
        }

        // --- FINAL STATUS ---
        if (intel.totalMatches === 0) {
            intel.matches.push({
                source_name: "Google Lens (Manual)",
                title: "View Results Manually",
                url: `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(mediaUrl)}`,
                posted_time: "Backup Link"
            });
        }

        return res.status(200).json({
            service: "osint-provider-switch-v39",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}
