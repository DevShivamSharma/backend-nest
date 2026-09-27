import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AssistController } from './assist.controller';
import { AssistService } from './assist.service';
import { HttpIntentProvider } from './intent-provider';

@Module({imports:[ConfigModule],controllers:[AssistController],providers:[AssistService,HttpIntentProvider]})
export class AssistModule {}
