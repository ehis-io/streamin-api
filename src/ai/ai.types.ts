export interface AiRecommendation {
    title: string;
    type: 'movie' | 'tv' | 'anime';
    reason?: string;
}

export interface GeneratedPlaylist {
    name: string;
    description: string;
    items: AiRecommendation[];
}
