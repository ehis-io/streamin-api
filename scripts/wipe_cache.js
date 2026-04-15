const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('--- CRITICAL: Database Cache Wipe Started ---');

  // 1. Wipe Dynamic Stream Cache
  const slCount = await prisma.streamedLink.deleteMany({});
  console.log(`Successfully wiped ${slCount.count} records from StreamedLink table.`);

  // 2. Wipe Scraper Mapping Cache
  const pmCount = await prisma.providerMapping.deleteMany({});
  console.log(`Successfully wiped ${pmCount.count} records from ProviderMapping table.`);

  console.log('--- Cache Wipe Complete: All dynamic stream links have been purged. ---');
}

main()
  .catch((e) => {
    console.error('Error during database wipe:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
