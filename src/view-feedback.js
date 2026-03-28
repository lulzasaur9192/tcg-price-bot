import { getRecentFeedback } from './db.js';

const feedback = getRecentFeedback(50);

if (feedback.length === 0) {
    console.log('No feedback yet.');
    process.exit(0);
}

console.log(`\n=== Recent Feedback (${feedback.length}) ===\n`);
for (const f of feedback) {
    console.log(`[${f.created_at}] ${f.username} (${f.platform}): ${f.message}`);
}
console.log();
process.exit(0);
