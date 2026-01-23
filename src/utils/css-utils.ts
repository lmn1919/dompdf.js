import {BACKGROUND_REPEAT} from '../css/property-descriptors/background-repeat';

export function getBackgroundRepeat(value: BACKGROUND_REPEAT): string {
    switch (value) {
        case BACKGROUND_REPEAT.NO_REPEAT:
            return 'no-repeat';
        case BACKGROUND_REPEAT.REPEAT_X:
            return 'repeat-x';
        case BACKGROUND_REPEAT.REPEAT_Y:
            return 'repeat-y';
        case BACKGROUND_REPEAT.REPEAT:
            return 'repeat';
        default:
            return 'no-repeat';
    }
}
