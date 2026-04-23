import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        const status =
            exception instanceof HttpException
                ? exception.getStatus()
                : HttpStatus.INTERNAL_SERVER_ERROR;

        const message =
            exception instanceof HttpException
                ? exception.getResponse()
                : 'Internal Server Error';

        // Standardize the error object/message
        const errorResponse = {
            statusCode: status,
            timestamp: new Date().toISOString(),
            path: request.url,
            message: (typeof message === 'object' && message !== null) ? message : { message },
        };

        // 🧱 Secure CORS for error responses
        const allowedOrigins = [
            'https://www.filmstreamer.org',
            'https://filmstreamer.org',
            'http://localhost:3000',
            'http://localhost:3001',
        ];
        const originHeader = request.headers.origin as string;
        const refererHeader = request.headers.referer as string;
        let refererOrigin: string | null = null;
        try { if (refererHeader) refererOrigin = new URL(refererHeader).origin; } catch (e) {}

        const finalOrigin = allowedOrigins.includes(originHeader) ? originHeader : 
                            (allowedOrigins.includes(refererOrigin!) ? refererOrigin : allowedOrigins[0]);

        response.setHeader('Access-Control-Allow-Origin', finalOrigin!);
        response.setHeader('Access-Control-Allow-Credentials', 'true');
        response.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', '*');
        response.setHeader('Access-Control-Expose-Headers', '*');

        response.status(status).json(errorResponse);

    }
}
