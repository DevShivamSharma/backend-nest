import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import { OrganisationEntity, OrganisationStatus } from '../organisations/organisation.entity';
import { BookingEntity } from './booking.entity';
import { venueReport } from './booking-rules';
import { VenueStatusDto } from './dto/booking.dto';

/**
 * Status reports from a venue's own booking system (`hybrid_hold`: it takes the payment for a
 * stall held here). The signature is checked before this runs (`VenueSignatureGuard`). Every
 * report is kept by its delivery id, so a repeated delivery changes nothing, and `venueReport`
 * decides what a report may do: a booking is confirmed only on a paid report, never by a client.
 */
@Injectable()
export class VenueStatusService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: AuditService,
  ) {}

  async receive(slug: string, dto: VenueStatusDto): Promise<{ outcome: string }> {
    return this.dataSource.transaction(async (em) => {
      // A suspended organisation looks the same as an unknown one, as on every other route.
      const organisation = await em
        .getRepository(OrganisationEntity)
        .findOneBy({ slug, status: OrganisationStatus.Active });
      if (!organisation) throw new NotFoundException('There is no such organisation.');
      const repo = em.getRepository(BookingEntity);
      const booking = await repo.findOne({
        where: { id: dto.bookingId, organisationId: organisation.id },
        lock: { mode: 'pessimistic_write' },
      });

      // The delivery is claimed first: the second of two identical reports finds it taken.
      const claimed: { id: string }[] = await em.query(
        `INSERT INTO booking_status_deliveries
                (organisation_id, delivery_id, booking_id, payload, outcome)
         VALUES ($1, $2, $3, $4, 'received')
         ON CONFLICT (organisation_id, delivery_id) DO NOTHING
         RETURNING id`,
        [organisation.id, dto.deliveryId, booking?.id ?? null, JSON.stringify(dto)],
      );
      if (!claimed.length) return { outcome: 'duplicate' };

      let outcome = 'ignored:unknown_booking';
      if (booking) {
        const result = venueReport(booking, dto);
        outcome = result.outcome;
        const changed =
          result.status !== booking.status || result.paymentStatus !== booking.paymentStatus;
        const tracked = booking.paymentStatus !== null;
        let dirty = changed;
        if (changed) {
          const from = booking.status;
          booking.status = result.status;
          booking.paymentStatus = result.paymentStatus;
          const now = new Date();
          if (result.status === 'confirmed' && from !== 'confirmed') booking.confirmedAt = now;
          if (result.status === 'cancelled' || result.status === 'expired') {
            booking.cancelledAt = now;
            booking.cancelReason = `Venue system: ${dto.bookingStatus} / ${dto.paymentStatus}`;
          }
          await this.audit.record(
            {
              action: `booking.venue_${outcome}`,
              actor: null,
              organisationId: organisation.id,
              targetType: 'booking',
              targetId: booking.id,
              metadata: {
                from,
                to: booking.status,
                paymentStatus: booking.paymentStatus,
                deliveryId: dto.deliveryId,
              },
            },
            em,
          );
        }
        // The venue's reference is kept for any booking whose payment it handles.
        if (tracked && dto.externalRef && booking.externalRef !== dto.externalRef) {
          const taken = await repo.findOneBy({
            organisationId: organisation.id,
            externalRef: dto.externalRef,
          });
          if (taken) {
            throw new ConflictException(
              `The reference ${dto.externalRef} already belongs to another booking.`,
            );
          }
          booking.externalRef = dto.externalRef;
          dirty = true;
        }
        if (dirty) await repo.save(booking);
      }
      await em.query(`UPDATE booking_status_deliveries SET outcome = $2 WHERE id = $1`, [
        claimed[0].id,
        outcome,
      ]);
      return { outcome };
    });
  }
}
