const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('--- Database Purge: Clearing Local Generation Cache ---');

  // 1. Clear StreamedLink cache
  const streamedLinkResult = await prisma.streamedLink.deleteMany({
    where: {
      OR: [
        { url: { contains: 'localhost' } },
        { url: { startsWith: '/api' } },
        { url: { contains: 'api/v1/streams/hls-proxy' } }
      ]
    }
  });
  console.log(`Deleted ${streamedLinkResult.count} stale records from StreamedLink table.`);

  // 2. Clear ProviderMapping (scrapers use this to skip searching)
  // If we were testing with a local provider or had cached localhost links here, clear them too.
  const providerMappingResult = await prisma.providerMapping.deleteMany({
    where: {
      OR: [
        { externalUrl: { contains: 'localhost' } }
      ]
    }
  });
  console.log(`Deleted ${providerMappingResult.count} stale records from ProviderMapping table.`);

  console.log('--- Purge Complete ---');
}

main()
  .catch((e) => {
    console.error('Error during database purge:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
