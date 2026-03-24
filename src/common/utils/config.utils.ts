import { ConfigService } from '@nestjs/config';

/**
 * 🛡️ Robustly resolves the absolute API URL.
 * Prioritizes API_URL env, fallbacks to localhost with PORT.
 */
export function getAbsoluteApiUrl(configService: ConfigService): string {
  const apiUrl = configService.get<string>('API_URL');
  if (apiUrl && apiUrl.startsWith('http')) return apiUrl;

  const port = configService.get<string | number>('PORT') || 4001;
  return `http://localhost:${port}`;
}
