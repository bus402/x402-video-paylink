import { useCallback, useState, useEffect } from "react";
import { generateOnrampSessionToken } from "../utils/utils";

type UseOnrampSessionTokenProps = {
  sessionToken: string | undefined;
};

const TOKEN_EXPIRY_TIME = 5 * 60 * 1000;

export function useOnrampSessionToken(address: string | undefined): UseOnrampSessionTokenProps {
  const [sessionToken, setSessionToken] = useState<string | undefined>();
  const [tokenTimestamp, setTokenTimestamp] = useState<number | null>(null);

  const isTokenExpired = useCallback(() => {
    if (!tokenTimestamp) return true;
    return Date.now() - tokenTimestamp > TOKEN_EXPIRY_TIME;
  }, [tokenTimestamp]);

  const generateToken = useCallback(async () => {
    if (!address) {
      return;
    }

    if (!sessionToken || isTokenExpired()) {
      const token = await generateOnrampSessionToken(address);
      setSessionToken(token);
      setTokenTimestamp(Date.now());
    }
  }, [address, sessionToken, isTokenExpired]);

  useEffect(() => {
    if (address) {
      generateToken();
    } else {
      setSessionToken(undefined);
      setTokenTimestamp(null);
    }
  }, [address, generateToken]);

  return {
    sessionToken,
  };
}
