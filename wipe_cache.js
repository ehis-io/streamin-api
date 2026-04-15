const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function wipe() {
  const deleted = await prisma.streamedLink.deleteMany({});
  console.log(`Deleted ${deleted.count} streams from cache.`);
  await prisma.$disconnect();
}
wipe();
