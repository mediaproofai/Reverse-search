import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

// 1. RESOLUTION DATABASE (The "Unknown Gen" Fix)
const RES_MAP = {
    '512x512': 'Stable Diffusion v1.5 / Midjourney v4',
    '640x640': 'Stable Diffusion v1.5 (Upscaled)',
    '768x768': 'Stable Diffusion v2.0',
    '1024x1024': 'SDXL / DALL-E 3 / Midjourney v5+',
    '1216x832': 'SDXL (Landscape)',
    '832x1216': 'SDXL (Portrait)',
    '1024x1792': 'Midjourney (Tall)',
    '1792x1024': 'Midjourney (Wide)',
    '1920x1080': 'Runway Gen-2 / Pika Labs'
};

// 2. FILENAME PATTERNS
const AI_PATTERNS = [
    { name: 'Midjourney', keys: ['midjourney', 'mj_', 'grid_0'] },
    { name: 'ElevenLabs', keys: ['elevenlabs', '11labs'] },
    { name: 'Suno AI', keys: ['suno'] },
    { name: 'Udio', keys: ['udio'] },
    { name: 'Sora', keys: ['sora'] }
];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // WE NOW ACCEPT 'metadata' to read dimensions directly
    const { mediaUrl, type, metadata } = req.body;
    const apiKey = process.env.SERPER_API_KEY;

    let intel = {
        totalMatches: 0,
        ai_generator_name: "Unknown",
        matches: [],
        method: "None",
        version: "osint-titanium-v11",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg)$/i);
        const filename = mediaUrl.split('/').pop().toLowerCase();
        const cleanName = filename.split('.')[0].replace(/[-_]/g, ' ');

        // --- PHASE 1: INTERNAL FORENSICS (No API Needed) ---
        
        // A. Check Filename
        for (const gen of AI_PATTERNS) {
            if (gen.keys.some(k => filename.includes(k))) {
                intel.ai_generator_name = `${gen.name} (Filename Trace)`;
            }
        }

        // B. Check Resolution (From Metadata Payload)
        // This fixes the "Unknown Gen" issue for generic filenames like "image.jpg"
        if (metadata && metadata.ExifImageWidth && metadata.ExifImageHeight) {
            const resKey = `${metadata.ExifImageWidth}x${metadata.ExifImageHeight}`;
            intel.debug.push(`Resolution Detected: ${resKey}`);
            
            if (intel.ai_generator_name === "Unknown" && RES_MAP[resKey]) {
                intel.ai_generator_name = `${RES_MAP[resKey]} (Resolution Match)`;
            }
        }

        // --- PHASE 2: EXTERNAL SEARCH ---
        if (apiKey) {
            let rawMatches = [];

            if (isAudio) {
                // AUDIO MODE: Text Only
                intel.debug.push("Audio Mode: Text Search");
                if (cleanName.length > 4) {
                    try {
                        const textRes = await fetch("https://google.serper.dev/search", {
                            method: "POST",
                            headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                            body: JSON.stringify({ q: `"${cleanName}" audio`, gl: "us", hl: "en" })
                        });
                        const data = await textRes.json();
                        rawMatches = data.organic || [];
                        if (rawMatches.length > 0) intel.method = "Audio Filename Match";
                    } catch (e) { intel.debug.push("Audio search fail"); }
                }
            } else {
                // VISUAL MODE: Lens -> Text Fallback
                intel.debug.push("Visual Mode: Lens");
                try {
                    const lensRes = await fetch("https://google.serper.dev/lens", {
                        method: "POST",
                        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                        body: JSON.stringify({ url: mediaUrl, gl: "us", hl: "en" })
                    });
                    const lensData = await lensRes.json();
                    if (lensData.visualMatches) rawMatches = lensData.visualMatches;
                    
                    if (rawMatches.length > 0) {
                        intel.method = "Visual Fingerprint";
                    } else {
                        // FALLBACK: Text Search for Filename
                        intel.debug.push("Lens 0 results -> Trying Text Fallback");
                        if (cleanName.length > 4) {
                            const textRes = await fetch("https://google.serper.dev/search", {
                                method: "POST",
                                headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                                body: JSON.stringify({ q: cleanName, gl: "us", hl: "en" })
                            });
                            const textData = await textRes.json();
                            if (textData.images) rawMatches = textData.images;
                        }
                    }
                } catch (e) { intel.debug.push("Search API Error"); }
            }

            // --- PHASE 3: CLEANUP ---
            const cleanMatches = rawMatches.filter(m => 
                !IGNORED.some(d => (m.link || "").includes(d))
            );

            intel.totalMatches = cleanMatches.length;
            intel.matches = cleanMatches.slice(0, 8).map(m => ({
                source_name: m.source || m.title || "Web Result",
                title: m.title || "External Match",
                url: m.link || "#",
                posted_time: "Found Online"
            }));

            // Context Check (Read Titles)
            if (intel.ai_generator_name === "Unknown" && cleanMatches.length > 0) {
                const combined = cleanMatches.map(m => m.title).join(" ").toLowerCase();
                if (combined.includes("midjourney")) intel.ai_generator_name = "Midjourney (Context)";
                else if (combined.includes("stable diffusion")) intel.ai_generator_name = "Stable Diffusion (Context)";
            }
        }

        // --- PHASE 4: FINAL FALLBACK ---
        if (intel.totalMatches === 0) {
            intel.matches.push({
                source_name: "System",
                title: "No Public Index Found",
                url: "#",
                posted_time: "File appears unique or private"
            });
        }

        return res.status(200).json({
            service: "osint-titanium-v11",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ service: "osint-crash", error: e.message });
    }
}
