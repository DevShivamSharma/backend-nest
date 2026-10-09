import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** Messages of the conversation the assistant is sent; older ones are dropped by the app. */
export const MAX_MESSAGES = 60;

export const ASSISTANT_ROLES = ['user', 'assistant', 'tool'] as const;
export type AssistantRole = (typeof ASSISTANT_ROLES)[number];

const TOOL_NAME = /^[a-z_]{1,64}$/;

/** A tool the model asked for. */
export class ToolCallDto {
  @IsString()
  @Length(1, 100)
  id!: string;

  @Matches(TOOL_NAME)
  name!: string;

  @IsObject()
  args!: Record<string, unknown>;

  /** Gemini's opaque signature of its reasoning, sent back with the call. */
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  signature?: string;
}

/**
 * One message: what the person said (`user`), what the model said and asked for (`assistant`),
 * or what a tool did (`tool`, answering the call `callId`).
 */
export class AssistantMessageDto {
  @IsIn(ASSISTANT_ROLES)
  role!: AssistantRole;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  text?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ToolCallDto)
  calls?: ToolCallDto[];

  @IsOptional()
  @IsString()
  @Length(1, 100)
  callId?: string;

  @IsOptional()
  @Matches(TOOL_NAME)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  result?: string;
}

export class AskAssistantDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MESSAGES)
  @ValidateNested({ each: true })
  @Type(() => AssistantMessageDto)
  messages!: AssistantMessageDto[];
}
