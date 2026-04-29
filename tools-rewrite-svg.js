const fs = require("fs");

const src = "C:\\Users\\김보영\\Desktop\\프레젠테이션.svg";
const dst = "C:\\Users\\김보영\\Desktop\\족보저장소\\assets\\footprints-bottom-slide.svg";

let s = fs.readFileSync(src, "utf8");

// Ensure viewBox for responsive scaling (only add if missing).
s = s.replace(/<svg\b(?![^>]*viewBox)/, '<svg viewBox="0 0 960 540"');

// Strip ASCII control chars invalid in XML (except tab/newline/CR).
s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

fs.writeFileSync(dst, s, "utf8");
console.log("wrote", dst, "len", s.length);

