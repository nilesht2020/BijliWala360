import { Injectable, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { BackgroundModule, BackgroundService } from './background.module';
import { CoreModule } from './core/core.module';
import { UsersModule } from './modules/users/users.module';

@Injectable()
class WorkerBootstrap implements OnApplicationBootstrap {
  constructor(private readonly background: BackgroundService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.background.start();
  }
}

/** Worker process root: background processing only, no HTTP API. */
@Module({ imports: [CoreModule, UsersModule, BackgroundModule], providers: [WorkerBootstrap] })
export class WorkerModule {}
