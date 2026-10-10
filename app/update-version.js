/** 更新 Android versionName/versionCode 与网页版本号保持一致 */
const fs = require('fs');
const path = require('path');

const VERSION = process.argv[2] || '1.3.0';
const CODE = parseInt(process.argv[3] || '3', 10);

const gradle = path.join(__dirname, 'android', 'app', 'build.gradle');
let text = fs.readFileSync(gradle, 'utf8');
text = text.replace(/versionCode \d+/, `versionCode ${CODE}`);
text = text.replace(/versionName "[^"]*"/, `versionName "${VERSION}"`);
fs.writeFileSync(gradle, text, 'utf8');
console.log(`  ✓ versionName=${VERSION} versionCode=${CODE}`);
