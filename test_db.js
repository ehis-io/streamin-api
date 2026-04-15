const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const links = await prisma.streamedLink.findMany({
    take: 10,
    orderBy: { createdAt: 'desc' }
  });
  console.log("Latest cached links in DB:");
  links.forEach(l => {
    console.log(`- Provider: ${l.provider}`);
    console.log(`  URL: ${l.url}`);
    console.log(`  Quality: ${l.quality}`);
    console.log(`  isM3U8: ${l.isM3U8}`);
  });
  await prisma.$disconnect();
}
check();
