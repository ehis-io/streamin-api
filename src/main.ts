import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableCors();
  app.setGlobalPrefix('api/v1');

  // Swagger Setup
  const config = new DocumentBuilder()
    .setTitle('Streaming Site API')
    .setDescription(
      'The Streaming Site API description\n\n' +
      '### WebSockets (Socket.io)\n' +
      'The API provides a real-time gateway for stream discovery and prefetching.\n\n' +
      '**Endpoint:** `/` (Root namespace)\n\n' +
      '**Events (Client -> Server):**\n' +
      '- `prefetch`: `{ items: Array<{ id: string, mediaType: "movie"|"tv"|"anime", title?: string }> }`\n' +
      '- `find-streams`: `{ id: string, season?: number, episode?: number, type?: "sub"|"dub", mediaType?: "movie"|"tv"|"anime" }`\n\n' +
      '**Events (Server -> Client):**\n' +
      '- `prefetch-link`: `{ id: string, link: StreamLink }` (Emitted for each found link during prefetch)\n' +
      '- `prefetch-complete`: `{ success: boolean, error?: string }` (Emitted when prefetch finishes)\n' +
      '- `stream-link`: `StreamLink` (Emitted for each found link during stream discovery)\n' +
      '- `streams-complete`: `StreamLink[]` (Final list of all discovered and validated links)'
    )
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(process.env.PORT ?? 4001);
}
bootstrap();
