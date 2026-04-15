const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./dist/app.module');
const { IframeResolverService } = require('./dist/providers/iframe-resolver.service');

async function test() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const resolver = app.get(IframeResolverService);
  
  console.log("Testing resolver with vidsrc embed directly...");
  const embedUrl = "https://vidsrc.pm/embed/tv?tmdb=42930&season=1&episode=1";
  
  const links = await resolver.resolve(embedUrl, 0);
  console.log("Extracted links:", JSON.stringify(links, null, 2));
  
  await app.close();
}

test().catch(console.error);
