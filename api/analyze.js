import fetch from 'node-fetch';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');

    const { mediaUrl } = req.body;
    
    // Default response structure
    let intel = {
        totalMatches: 0,
        sources: { stockParams: false },
        patientZero: { source: "N/A", url: null }
    };

    try {
        if (process.env.SERPER_API_KEY) {
            const response = await fetch("https://google.serper.dev/search", {
                method: "POST",
                headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
                body: JSON.stringify({ q: mediaUrl, type: "images" })
            });
            
            const data = await response.json();
            
            if (data.images) {
               // FILTER: Remove Cloudinary, Verel, and Blob URLs
const validMatches = data.images.filter(img => 
    !img.link.includes("cloudinary.com") && 
    !img.link.includes("vercel.app") &&
    !img.source.includes("Cloudinary")
);

                intel.totalMatches = validMatches.length;
                intel.sources.stockParams = validMatches.some(m => m.source.match(/shutter|getty|adobe|stock/i));
                
                // Find oldest result (Patient Zero)
                if (validMatches.length > 0) {
                    // Sort by date if available, otherwise assume last is oldest
                    const oldest = validMatches[validMatches.length - 1];
                    intel.patientZero = { source: oldest.source, url: oldest.link };
                }
            }
        }

        return res.status(200).json({
            service: "osint-unit-v2",
            footprintAnalysis: intel,
            timelineIntel: { patientZero: intel.patientZero }
        });

    } catch (e) {
        return res.status(200).json({ service: "osint-error", footprintAnalysis: intel });
    }
}
