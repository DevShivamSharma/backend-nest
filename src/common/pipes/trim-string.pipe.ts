import { PipeTransform, Injectable } from '@nestjs/common';

@Injectable()
export class TrimPipe implements PipeTransform {
  transform(value: any) {
    if (value && typeof value === 'object') {
      for (const key in value) {
        if (typeof value[key] === 'string') {
          value[key] = value[key].trim();
        }
      }
    } else if (typeof value === 'string') {
      return value.trim();
    }

    return value;
  }
}
