import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Example: Sintel (Open movie)
  const movie1 = await prisma.movie.upsert({
    where: { tmdbId: 60735 },
    update: {},
    create: {
      tmdbId: 60735,
      title: 'Sintel',
      type: 'movie',
      providers: {
        create: [
          {
            name: 'YouTube',
            embedUrl: 'https://www.youtube.com/embed/eRsGyueVLvQ',
            priority: 1,
          },
          {
            name: 'Vimeo',
            embedUrl: 'https://player.vimeo.com/video/10570139',
            priority: 2,
          },
        ],
      },
    },
  });

  // Example: Big Buck Bunny
  const movie2 = await prisma.movie.upsert({
    where: { tmdbId: 10378 },
    update: {},
    create: {
      tmdbId: 10378,
      title: 'Big Buck Bunny',
      type: 'movie',
      providers: {
        create: [
          {
            name: 'YouTube',
            embedUrl: 'https://www.youtube.com/embed/aqz-KE-bpKQ',
            priority: 1,
          },
        ],
      },
    },
  });

  console.log('Seed completed:', { movie1, movie2 });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
