import React from 'react';

import { Button } from '@actual-app/components/button';
import { View } from '@actual-app/components/view';

import { useTagCSS } from '@desktop-client/hooks/useTagCSS';
import {Text} from "@actual-app/components/text";
import {Trans} from "react-i18next";
import {Tooltip} from "@actual-app/components/tooltip";
import {styles} from "@actual-app/components/styles";

type DesktopTaggedNotesProps = {
  content: string;
  comment?: string;
  onPress?: (content: string) => void;
  tag: string;
  separator: string;
};

export function DesktopTaggedNotes({
  content,
  comment,
  onPress,
  tag,
  separator,
}: DesktopTaggedNotesProps) {
  const getTagCSS = useTagCSS();
  return (
    <View style={{ display: 'inline' }}>
      <Button
        variant="bare"
        className={getTagCSS(tag)}
        onPress={() => {
          onPress?.(content);
        }}
      >
        {comment ? (
          <Tooltip
            content={
              <View style={{ padding: 10 }}>
                <Text style={{ fontWeight: 'normal' }}>
                  {comment}
                </Text>
              </View>
            }
            style={{ ...styles.tooltip, borderRadius: '0px 5px 5px 0px' }}
            placement="bottom"
            triggerProps={{ delay: 750 }}
          >
            {content}
          </Tooltip>
        ) : (
          content
        )}
      </Button>
      {separator}
    </View>
  );
}
