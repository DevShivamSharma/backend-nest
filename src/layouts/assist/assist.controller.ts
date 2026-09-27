import { Body, Controller, HttpCode, HttpException, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AssistService } from './assist.service';
import { validateRequest } from './assist-request';

@Controller('layout/assist')
export class AssistController {
  private readonly clients = new Map<string,{start:number;count:number}>();
  constructor(private readonly service: AssistService) {}
  @Post()
  @HttpCode(200)
  assist(@Body() body: unknown, @Req() request: Request) {
    const now = Date.now();
    for (const [key,entry] of this.clients) if (now-entry.start >= 60000) this.clients.delete(key);
    const key = request.ip ?? request.socket?.remoteAddress ?? 'local';
    const entry = this.clients.get(key) ?? {start:now,count:0};
    if (entry.count >= 10 || (!this.clients.has(key) && this.clients.size >= 10000)) throw new HttpException('Too many layout requests. Try again in a minute.',429);
    entry.count++; this.clients.set(key,entry);
    return this.service.assist(validateRequest(body));
  }
}
