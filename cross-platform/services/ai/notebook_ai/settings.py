from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NOTEBOOK_AI_", env_file=".env", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 8787
    api_token: str | None = None
    # `null` is the origin used by the packaged Electron renderer (file://).
    # 8057 is retained for the local browser build used by the migration UI.
    allowed_origins: str = "null,http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:8057,http://localhost:8057"
    database_url: str = "sqlite+aiosqlite:///./notebook-next.db"
    jwt_secret: str | None = None
    enable_local_sftp_bridge: bool = False

    @property
    def origins(self) -> list[str]:
        return [value.strip() for value in self.allowed_origins.split(",") if value.strip()]
