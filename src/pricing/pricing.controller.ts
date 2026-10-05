import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { PricingService } from './pricing.service';

@Controller('price-masters')
export class PriceMastersController {
  constructor(private readonly pricing: PricingService) {}
  @Get() list() { return this.pricing.list(); }
  @Get('library') library() { return this.pricing.library(); }
  @Post() create(@Body() body: unknown) { return this.pricing.create(body); }
  @Post('import') import(@Body() body: { rows?: unknown }) { return this.pricing.importRows(body?.rows); }
  @Put(':id') update(@Param('id', ParseIntPipe) id: number, @Body() body: { revision?: number; master?: unknown }) { return this.pricing.update(id, body); }
}
@Controller('layout')
export class LayoutPricingController {
  constructor(private readonly pricing: PricingService) {}
  @Put(':id/pricing') @HttpCode(200)
  assign(@Param('id', ParseIntPipe) id: number, @Body() body: { masterId?: number; revision?: number }) { return this.pricing.assign(id, body); }
  @Get(':id/stalls/:stallNumber/quote')
  quote(@Param('id', ParseIntPipe) id: number, @Param('stallNumber') number: string, @Query('stallType') type: string) { return this.pricing.quote(id, number, type); }
}
