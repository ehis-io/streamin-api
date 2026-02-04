import { Module, Global } from '@nestjs/common';
import { PuppeteerService } from './puppeteer.service';

@Global()
@Module({
  providers: [PuppeteerService],
  exports: [PuppeteerService],
})
export class PuppeteerModule {}
