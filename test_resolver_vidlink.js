const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./dist/app.module');
const { IframeResolverService } = require('./dist/providers/iframe-resolver.service');

async function test() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const resolver = app.get(IframeResolverService);
  
  console.log("Testing resolver with vidlink embed directly...");
  const embedUrl = "https://vidlink.pro/tv/281392/1/1?primaryColor=e50914&player=default&autoplay=true";
  
  const links = await resolver.resolve(embedUrl, 0);
  console.log("Extracted links:", JSON.stringify(links, null, 2));
  
  await app.close();
}

test().catch(console.error);
