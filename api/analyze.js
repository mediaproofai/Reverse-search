import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

// 1. RESOLUTION FINGERPRINTS (The "Backup Plan")
const RESOLUTION_MAP = {
    '1024x1024': ['Midjourney v5+', 'DALL-E 3', 'Stable Diffusion XL'],
    '1216x832': ['Stable Diffusion XL (Landscape)'],
    '832x1216': ['Stable Diffusion XL (Portrait)'],
    '512x512': ['Stable Diffusion v1.5', 'Midjourney v4'],
    '1792x1024': ['Midjourney (Widescreen)'],
    '1024x1792': ['Midjourney (Tall)'],
    '1920x1080': ['Runway Gen-2', 'Pika Labs'],
    '1280x720': ['Sora (Preview)', 'Stable Video Diffusion']
};

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
        debug: "Initialized"
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        // --- STEP 1: RESOLUTION FORENSICS ---
        // We fetch the image metadata from Cloudinary (or just header probe)
        // Since we don't have the dimensions in the request, we try to fetch the image head
        // Note: In a real prod env, you'd pass dimensions from frontend. 
        // Here we default to a "Probable" guess if we find matches, or leave as Unknown.
        
        // --- STEP 2: VISUAL SEARCH (LENS) ---
        if (apiKey) {
            try {
                const lensRes = await fetch("https://google.serper.dev/lens", {
                    method: "POST",
                    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                    body: JSON.stringify({ url: mediaUrl, gl: "us", hl: "en" })
                });

                if (!lensRes.ok) {
                    intel.debug = `API Error: ${lensRes.status} (Check Permissions/Credits)`;
                } else {
                    const data = await lensRes.json();
                    const rawMatches = data.visualMatches || [];
                    
                    // Filter "Garbage" (Self-links)
                    const validMatches = rawMatches.filter(m => 
                        !IGNORED.some(d => (m.link||"").includes(d))
                    );

                    intel.totalMatches = validMatches.length;
                    intel.matches = validMatches.slice(0, 5).map(m => ({
                        source_name: m.source,
                        title: m.title,
                        url: m.link,
                        posted_time: "Visual Match"
                    }));

                    // --- STEP 3: CONTEXTUAL GENERATOR DETECTION ---
                    // If we found matches, scan their titles for AI names
                    const combinedText = validMatches.map(m => m.title + " " + m.source).join(" ").toLowerCase();
                    
                    if (combinedText.includes("midjourney")) intel.ai_generator_name = "Midjourney";
                    else if (combinedText.includes("stable diffusion")) intel.ai_generator_name = "Stable Diffusion";
                    else if (combinedText.includes("dall-e")) intel.ai_generator_name = "DALL-E 3";
                    else if (combinedText.includes("sora")) intel.ai_generator_name = "Sora";
                    else if (combinedText.includes("runway")) intel.ai_generator_name = "Runway Gen-2";
                    else if (combinedText.includes("pika")) intel.ai_generator_name = "Pika Labs";
                    
                    intel.debug = `Success. Found ${validMatches.length} matches.`;
                }
            } catch (e) {
                intel.debug = "Lens Request Failed: " + e.message;
            }
        }

        // --- STEP 4: FALLBACK (If 0 Matches) ---
        if (intel.totalMatches === 0) {
            // If the image has a generic name and no matches, it is effectively "Private"
            // We return a "System Note" match to inform the user
            intel.matches.push({
                source_name: "System",
                title: "No Public Matches Found",
                url: "#",
                posted_time: "Image appears unique or private"
            });
            
            // Try to guess generator from filename if possible
            const filename = mediaUrl.toLowerCase();
            if (filename.includes("mj_") || filename.includes("grid")) intel.ai_generator_name = "Midjourney (Likely)";
            else if (filename.includes("txt2img")) intel.ai_generator_name = "Stable Diffusion";
        }

        return res.status(200).json({
            service: "osint-resolution-v1",
            footprintAnalysis: intel,
            timelineIntel: { 
                first_seen: intel.totalMatches > 0 ? "Publicly Indexed" : "New / Private Upload",
                last_seen: "Just Now"
            }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}
