import fetch from 'node-fetch';
import sizeOf from 'image-size'; // We will use a lightweight fetch instead

// RESOLUTION FINGERPRINTS
const RES_MAP = {
    '512x512': 'Stable Diffusion v1.5 / Midjourney v4',
    '640x640': 'Stable Diffusion v1.5 (Upscaled)',
    '768x768': 'Stable Diffusion v2.0',
    '1024x1024': 'SDXL / DALL-E 3 / Midjourney v5+',
    '1216x832': 'SDXL (Landscape)',
    '832x1216': 'SDXL (Portrait)',
    '1024x1792': 'Midjourney (Tall)',
    '1792x1024': 'Midjourney (Wide)'
};

const AI_LABS = [
    { name: 'Midjourney', keys: ['midjourney', 'mj_'] },
    { name: 'DALL-E', keys: ['dalle', 'dall-e'] },
    { name: 'Stable Diffusion', keys: ['stable diffusion', 'sdxl'] },
    { name: 'Sora', keys: ['sora'] }
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
        ai_generator_name: "Unknown",
        matches: [],
        method: "None",
        version: "osint-omni-v7", // VERIFY THIS
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        // --- PHASE 1: DIMENSION FORENSICS (The "Unknown Gen" Fix) ---
        // We fetch the first 10KB to get the header dimensions
        try {
            const headRes = await fetch(mediaUrl, { headers: { Range: 'bytes=0-10240' } });
            const buffer = await headRes.buffer();
            const dims = sizeOf(buffer);
            const resKey = `${dims.width}x${dims.height}`;
            
            intel.debug.push(`Dimensions: ${resKey}`);
            
            if (RES_MAP[resKey]) {
                intel.ai_generator_name = `${RES_MAP[resKey]} (Resolution Match)`;
            }
        } catch (e) { intel.debug.push("Dimension check failed: " + e.message); }

        // --- PHASE 2: VISUAL SEARCH (LENS) ---
        if (apiKey) {
            try {
                const lensRes = await fetch("https://google.serper.dev/lens", {
                    method: "POST",
                    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                    body: JSON.stringify({ url: mediaUrl, gl: "us", hl: "en" })
                });

                if (!lensRes.ok) {
                    intel.debug.push(`Serper Error: ${lensRes.status}`);
                } else {
                    const data = await lensRes.json();
                    let rawMatches = [];
                    if (data.knowledgeGraph) rawMatches.push(data.knowledgeGraph);
                    if (data.visualMatches) rawMatches = rawMatches.concat(data.visualMatches);

                    if (rawMatches.length > 0) {
                        intel.method = "Visual Fingerprint";
                        // FILTER: Remove self-links
                        const cleanMatches = rawMatches.filter(m => !(m.link||"").includes("cloudinary"));
                        
                        intel.totalMatches = cleanMatches.length;
                        intel.matches = cleanMatches.slice(0, 8).map(m => ({
                            source_name: m.source || "Web Result",
                            title: m.title || "Visual Match",
                            url: m.link || "#",
                            posted_time: "Found Online"
                        }));

                        // If Gen is still unknown, check titles
                        if (intel.ai_generator_name.includes("Unknown")) {
                            const text = cleanMatches.map(m => m.title).join(" ").toLowerCase();
                            for (const gen of AI_LABS) {
                                if (gen.keys.some(k => text.includes(k))) {
                                    intel.ai_generator_name = `${gen.name} (Context Match)`;
                                    break;
                                }
                            }
                        }
                    } else {
                        intel.debug.push("Google returned 0 visual matches.");
                    }
                }
            } catch (e) { intel.debug.push("Lens API fail: " + e.message); }
        }

        // --- PHASE 3: FINAL FALLBACK ---
        // If we still have 0 matches, explicitly say why
        if (intel.totalMatches === 0) {
            intel.matches.push({
                source_name: "System",
                title: "No Public Index Found",
                url: "#",
                posted_time: "Image appears unique/private"
            });
        }

        return res.status(200).json({
            service: "osint-omni-v7",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}
