import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger(HttpExceptionFilter.name);

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

        // Log non-HTTP (unexpected) errors with their stack for observability —
        // otherwise every crash is silently mapped to a bland 500.
        if (!(exception instanceof HttpException)) {
            const err = exception as Error;
            this.logger.error(`Unhandled error on ${request.method} ${request.url}: ${err?.message}`, err?.stack);
        }

        // If the response has already started (e.g. a streaming/proxy pipe), we can't
        // rewrite headers/status — doing so throws "headers already sent". Just end it.
        if (response.headersSent) {
            response.end();
            return;
        }

        // Standardize the error object/message
        const errorResponse = {
            statusCode: status,
            timestamp: new Date().toISOString(),
            path: request.url,
            message: (typeof message === 'object' && message !== null) ? message : { message },
        };

        response.status(status).json(errorResponse);
    }
}
