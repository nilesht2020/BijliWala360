declare module 'ioredis-mock' {
  import Redis from 'ioredis';
  /** ioredis-mock implements the ioredis API in memory. */
  const RedisMock: typeof Redis;
  export default RedisMock;
}
