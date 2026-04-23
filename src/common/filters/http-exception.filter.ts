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

        // 🧱 CORS for error responses
        // 🧱 Nuclear CORS fallback for error responses
        const origin = request.headers.origin || (request.headers.referer ? new URL(request.headers.referer as string).origin : '*');
        
        response.setHeader('Access-Control-Allow-Origin', origin);
        if (origin !== '*') {
            response.setHeader('Access-Control-Allow-Credentials', 'true');
        }
        response.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept,Authorization,Origin,Range,Referer,Cache-Control,Pragma,X-Requested-With,X-Playback-Session-Id');
        response.setHeader('Access-Control-Expose-Headers', 'Content-Range,Content-Length,Accept-Ranges');

        response.status(status).json(errorResponse);

    }
}
