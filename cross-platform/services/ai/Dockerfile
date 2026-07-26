FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY pyproject.toml ./
COPY notebook_ai ./notebook_ai
RUN pip install --no-cache-dir .

EXPOSE 8787
CMD ["uvicorn", "notebook_ai.main:app", "--host", "0.0.0.0", "--port", "8787"]
