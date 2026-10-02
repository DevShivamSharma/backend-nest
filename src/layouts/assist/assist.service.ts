import { Injectable, Logger } from '@nestjs/common';
import { HttpIntentProvider, InvalidIntentError, RateLimitedError } from './intent-provider';
import { parseSimple, type LayoutIntent } from './intent';
import { planStalls } from './plan-stalls';
import type { AssistRequest } from './assist-request';

@Injectable()
export class AssistService {
  private readonly logger = new Logger(AssistService.name);
  constructor(private readonly provider: HttpIntentProvider) {}
  async assist(request: AssistRequest) {
    let intent: LayoutIntent | undefined;
    let source = 'simple parser';
    let notice = 'AI is not configured; using the simple parser.';
    if (this.provider.configured()) {
      const abort = new AbortController();
      // The retry shares one deadline, rather than doubling the 15 second wait.
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new Error('Timeout'));},15000);});
      try {
        intent = await Promise.race([(async()=>{
          try { return await this.provider.interpret(request,abort.signal); }
          catch (error) {
            // Free tiers allow only a few requests a minute: wait out a short 429 once, inside the same deadline.
            if (error instanceof RateLimitedError && error.retryAfterMs !== null && error.retryAfterMs <= 5000) {
              await new Promise(resolve=>setTimeout(resolve,error.retryAfterMs!));
              return this.provider.interpret(request,abort.signal);
            }
            if (!(error instanceof InvalidIntentError)) throw error; return this.provider.interpret(request,abort.signal);
          }
        })(),timeout]);
        source = 'AI'; notice = '';
      } catch (error) {
        const reason = error instanceof InvalidIntentError ? 'invalid_intent' : error instanceof Error && error.message === 'Timeout' ? 'timeout' : error instanceof Error && /^Provider request failed \(\d+\)\.$/.test(error.message) ? error.message : 'unavailable';
        this.logger.warn(`Assistant provider fallback: ${reason}`);
        notice = 'AI is unavailable or returned an invalid reply; using the simple parser. Try a size, count and named marker or wall.';
      }
      finally { clearTimeout(timer!); }
    }
    intent ??= parseSimple(request.requirement);
    this.logger.log(JSON.stringify({ action:intent.action, stallSize:intent.stallSize, count:intent.count, areaType:intent.area.type, arrangement:intent.arrangement, aisleWidth:intent.aisleWidth, source }));
    const plan = planStalls(intent,request);
    if (notice) plan.notes.unshift(notice);
    return { ...plan, source };
  }
}
