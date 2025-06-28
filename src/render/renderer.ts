import { Context } from '../core/context';
import { RenderConfigurations } from './canvas/pdf-renderer';

export class Renderer {
    constructor(protected readonly context: Context, protected readonly options: RenderConfigurations) {}
}
