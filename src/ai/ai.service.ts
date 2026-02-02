import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GeneratedPlaylist } from './ai.types';

@Injectable()
export class AiService {
    private readonly genAI: GoogleGenerativeAI;
    private readonly model: any;
    private readonly logger = new Logger(AiService.name);

    constructor(private configService: ConfigService) {
        const apiKey = this.configService.get<string>('GEMINI_API_KEY');
        if (apiKey) {
            this.genAI = new GoogleGenerativeAI(apiKey);
            this.model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        }
    }

    async generatePlaylist(prompt: string): Promise<GeneratedPlaylist | null> {
        if (!this.model) {
            this.logger.error('Gemini API key is missing');
            return null;
        }

        const systemPrompt = `You are a movie and anime expert. Based on the user's description, generate a personalized playlist.
Return a JSON object with the following structure:
{
  "name": "Short Catchy Playlist Name",
  "description": "Brief description of why these were chosen",
  "items": [
    { "title": "Movie or Show Name", "type": "movie" | "tv" | "anime" }
  ]
}
Recommend 5 to 8 items. Be accurate with titles. Ensure 'type' is one of: movie, tv, anime.
Return ONLY valid JSON. No markdown backticks.`;

        try {
            const result = await this.model.generateContent([
                systemPrompt,
                `User shared: ${prompt}`
            ]);

            const text = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(text);
        } catch (e) {
            this.logger.error(`AI Generation failed: ${e.message}`);
            return null;
        }
    }
}
