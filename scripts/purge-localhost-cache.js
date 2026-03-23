/**
 * purge-localhost-cache.js
 *
 * Run this script on the backend server to remove all MongoDB-cached stream links
 * that contain localhost URLs. These are stale entries from before the API_URL was
 * corrected to the production URL.
 *
 * Usage:
 *   node scripts/purge-localhost-cache.js
 *
 * Requires: DATABASE_URL env var to be set (or a .env file present).
 */

const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Searching for cached stream links containing "localhost"...');

  const badLinks = await prisma.streamedLink.findMany({
    where: {
      url: { contains: 'localhost' }
    },
    select: { id: true, url: true }
  });

  if (badLinks.length === 0) {
    console.log('✅ No localhost-cached links found. Cache is clean!');
    return;
  }

  console.log(`⚠️  Found ${badLinks.length} stale localhost link(s). Deleting...`);
  badLinks.forEach(l => console.log(`   - ${l.url.substring(0, 100)}`));

  const result = await prisma.streamedLink.deleteMany({
    where: {
      url: { contains: 'localhost' }
    }
  });

  console.log(`✅ Deleted ${result.count} stale link(s) from the database.`);
}

main()
  .catch(e => { console.error('❌ Error:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
