import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmailRecipientsController } from './controllers/email-recipients.controller';
import { EmailRecipientListEntity } from './infrastructure/persistence/relational/entities/email-recipient-list.entity';
import { EmailRecipientEntity } from './infrastructure/persistence/relational/entities/email-recipient.entity';
import { EmailRecipientsService } from './services/email-recipients.service';

/** Global, so any module can ask for the addresses of a list by its slug. */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([EmailRecipientListEntity, EmailRecipientEntity])],
  controllers: [EmailRecipientsController],
  providers: [EmailRecipientsService],
  exports: [EmailRecipientsService],
})
export class EmailRecipientsModule {}
