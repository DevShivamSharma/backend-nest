import { IsBoolean, IsInt, Max, Min } from 'class-validator';

export class FeaturesDto {
  @IsBoolean()
  aiAssist!: boolean;

  @IsBoolean()
  pdfPlot!: boolean;

  @IsBoolean()
  exhibitorPortal!: boolean;

  @IsBoolean()
  wayfinding!: boolean;
}

export class LimitsDto {
  @IsInt()
  @Min(1)
  @Max(1000)
  venues!: number;

  @IsInt()
  @Min(1)
  @Max(100_000)
  users!: number;

  @IsInt()
  @Min(100)
  @Max(10_000_000)
  storageMb!: number;
}
